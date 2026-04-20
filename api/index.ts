import express, { Request, Response, NextFunction } from "express";
import { Pool } from "pg";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import {
  buildFishesPayload,
  PublishBuyInInput,
  PublishPlayerInput,
} from "./lib/publishToLedger.js";
import {
  buildCumulative,
  buildPlayerHistoryEvents,
  SessionResultRow,
  SettlementRow,
} from "./lib/playerHistory.js";

dotenv.config();

// Augment Express Request so handlers read req.tenantId type-safely. The
// tenant-resolve middleware below sets it on every /api/* request except
// the small exempt set (/api/health, /api/tenants/resolve, POST /api/tenants).
declare module "express-serve-static-core" {
  interface Request {
    tenantId?: string;
  }
}

const app = express();
app.use(express.json({ limit: "20mb" }));

// Treat loopback and common dev hosts as local (no SSL). Public hosts get SSL.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "host.docker.internal"];
const isLocalDb = LOCAL_HOSTS.some((h) => process.env.DATABASE_URL?.includes(h));

// Extract host:port for boot-time logging without leaking credentials.
// Matches the host/port segment of a postgres URL, tolerates missing port.
function dbTargetForLog(url: string | undefined): string {
  if (!url) return "<unset>";
  const m = url.match(/@([^/?#]+)/);
  return m ? m[1] : "<unparseable>";
}

console.log(`[db] target: ${dbTargetForLog(process.env.DATABASE_URL)} (ssl: ${isLocalDb ? "off" : "on"})`);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

// Track whether initDB ever succeeded. Used by the /api/live middleware to
// short-circuit requests with 503 when the DB is known-unhealthy, rather than
// letting them hit the pool and bubble 500s.
let dbReady = false;

// Surface pool-level errors (e.g. idle client disconnects) without crashing the
// process. Without this handler, emitted 'error' events on the Pool become
// uncaught exceptions.
pool.on("error", (err) => {
  console.error("[db] pool error:", err.message);
  dbReady = false;
});

// ---------------------------------------------------------------------------
// Database initialisation — creates all tables on first run
// ---------------------------------------------------------------------------
const initDB = async () => {
  let client;
  try {
    client = await pool.connect();
    // ── Fishes tables (existing) ────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS players (
        id   SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id   SERIAL PRIMARY KEY,
        date TEXT NOT NULL,
        note TEXT
      );

      CREATE TABLE IF NOT EXISTS session_results (
        id         SERIAL  PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id)  ON DELETE CASCADE,
        player_id  INTEGER NOT NULL REFERENCES players(id)   ON DELETE CASCADE,
        amount     REAL    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settlements (
        id       SERIAL  PRIMARY KEY,
        payer_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        payee_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        amount   REAL    NOT NULL,
        date     TEXT    NOT NULL,
        status   TEXT    DEFAULT 'completed'
      );

      CREATE TABLE IF NOT EXISTS player_aliases (
        id        SERIAL  PRIMARY KEY,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        alias     TEXT    UNIQUE NOT NULL
      );

      ALTER TABLE settlements ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'completed';
    `);

    // ── Live (Thor) tables (new) ────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS live_users (
        id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        name       TEXT        NOT NULL,
        username   TEXT        NOT NULL UNIQUE,
        password   TEXT        NOT NULL,
        mobile     TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS live_sessions (
        id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        name         TEXT        NOT NULL,
        session_code TEXT        NOT NULL UNIQUE,
        blind_value  TEXT        DEFAULT '10/20',
        created_by   UUID        REFERENCES live_users(id) ON DELETE SET NULL,
        status       TEXT        NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','closed')),
        closed_at    TIMESTAMPTZ,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS live_session_players (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id     UUID REFERENCES live_sessions(id) ON DELETE CASCADE,
        user_id        UUID REFERENCES live_users(id)    ON DELETE CASCADE,
        role           TEXT NOT NULL DEFAULT 'player'
                       CHECK (role IN ('admin','player')),
        final_winnings NUMERIC
      );

      CREATE TABLE IF NOT EXISTS live_buy_ins (
        id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID        REFERENCES live_sessions(id) ON DELETE CASCADE,
        user_id    UUID        REFERENCES live_users(id)    ON DELETE CASCADE,
        amount     NUMERIC     NOT NULL,
        status     TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected')),
        timestamp  TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE live_sessions
        ADD COLUMN IF NOT EXISTS published_to_ledger  BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS published_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_live_sessions_code   ON live_sessions(session_code);
      CREATE INDEX IF NOT EXISTS idx_live_buy_ins_session ON live_buy_ins(session_id);
      CREATE INDEX IF NOT EXISTS idx_live_sp_session      ON live_session_players(session_id);
      CREATE INDEX IF NOT EXISTS idx_live_sp_user         ON live_session_players(user_id);
    `);
    dbReady = true;
    console.log("[db] initDB ok — schema verified");
  } catch (err) {
    // Keep the server process alive even when Postgres is unreachable at
    // boot. Routes that need the DB will still fail with 503s, but at least
    // the static SPA loads and the user sees a degraded UI instead of a
    // blank page.
    console.error("[db] initDB failed — server will stay up, API calls will fail until DB is reachable:", err instanceof Error ? err.message : err);
  } finally {
    if (client) client.release();
  }
};

// Don't await — initDB failures must not keep the HTTP server from binding.
initDB().catch((err) => console.error("[db] initDB rejected:", err));

// ===========================================================================
// ── TENANCY — health, resolve middleware, tenant CRUD ───────────────────────
// ===========================================================================
//
// Every /api/* route (except the small exempt set) runs behind resolveTenant.
// The middleware reads X-Tenant-Code, validates it against `tenants` (via a
// tiny in-memory LRU), and attaches req.tenantId.
//
// Exempt paths:
//   - GET  /api/health            — liveness probe, no tenant needed
//   - GET  /api/tenants/resolve   — used BEFORE login to check a code exists
//   - POST /api/tenants           — creates a new tenant (bootstrap op)
// ---------------------------------------------------------------------------

// Liveness probe — declared before the tenant middleware so it stays
// reachable even without a tenant header. Does not touch the DB so it
// still answers during DB outages.
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, dbReady });
});

// ── Tenant-code LRU ─────────────────────────────────────────────────────────
// Small, process-local cache: upper-cased tenant code -> tenant_id.
// Max 100 entries, 5 min TTL. Map preserves insertion order, so
// "evict oldest" == "delete first key". Accesses re-insert the entry
// to bump it to MRU. TTL is checked lazily on read. NOT a shared cache —
// every serverless instance has its own, which is fine because the only
// cost of a miss is one SELECT.
const TENANT_CACHE_MAX = 100;
const TENANT_CACHE_TTL_MS = 5 * 60 * 1000;
interface TenantCacheEntry {
  tenantId: string;
  expiresAt: number;
}
const tenantCache = new Map<string, TenantCacheEntry>();

function tenantCacheGet(code: string): string | null {
  const key = code.toUpperCase();
  const hit = tenantCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    tenantCache.delete(key);
    return null;
  }
  // Re-insert to mark MRU.
  tenantCache.delete(key);
  tenantCache.set(key, hit);
  return hit.tenantId;
}

function tenantCacheSet(code: string, tenantId: string): void {
  const key = code.toUpperCase();
  if (tenantCache.has(key)) tenantCache.delete(key);
  tenantCache.set(key, { tenantId, expiresAt: Date.now() + TENANT_CACHE_TTL_MS });
  while (tenantCache.size > TENANT_CACHE_MAX) {
    const oldest = tenantCache.keys().next().value;
    if (oldest === undefined) break;
    tenantCache.delete(oldest);
  }
}

// Exported for tests.
export function __resetTenantCacheForTests(): void {
  tenantCache.clear();
}

// Paths that bypass tenant resolution. The middleware is mounted on
// `/api`, so Express strips that prefix before it sees `req.path`. We
// therefore compare against the post-strip path here. The comments list
// the full original URL so grep-by-url still works.
const EXEMPT_PATHS = new Set<string>([
  "/health",          // full: /api/health
  "/tenants/resolve", // full: /api/tenants/resolve
]);

async function resolveTenant(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (EXEMPT_PATHS.has(req.path)) return next();
  // POST /api/tenants is the bootstrap "create new group" op; other methods
  // on the same path (if ever added) should still require a tenant.
  // `req.path` here is "/tenants" because app.use("/api", ...) strips the
  // mount prefix.
  if (req.path === "/tenants" && req.method === "POST") return next();

  const header = req.header("X-Tenant-Code");
  const code = header?.trim();
  if (!code) {
    res.status(401).json({ error: "missing_tenant_code" });
    return;
  }

  const cached = tenantCacheGet(code);
  if (cached) {
    req.tenantId = cached;
    return next();
  }

  try {
    const result = await pool.query(
      "SELECT id FROM tenants WHERE LOWER(code) = LOWER($1)",
      [code]
    );
    if (result.rows.length === 0) {
      res.status(401).json({ error: "invalid_tenant_code" });
      return;
    }
    const tenantId: string = result.rows[0].id;
    tenantCacheSet(code, tenantId);
    req.tenantId = tenantId;
    next();
  } catch (err) {
    console.error("[tenancy] resolveTenant lookup failed:", err);
    res.status(503).json({ error: "database unavailable" });
  }
}

// Mount on /api so only API routes go through it. Vite/static serving
// upstream is untouched. /api/health is declared above and never reaches
// this middleware.
app.use("/api", resolveTenant);

// ── Tenant CRUD ─────────────────────────────────────────────────────────────

// Alphanumeric alphabet for auto-generated tenant codes. Ambiguous glyphs
// (0/O, 1/l/I) are excluded so codes are readable off a phone screen.
const TENANT_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateTenantCode(): string {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += TENANT_CODE_ALPHABET.charAt(
      Math.floor(Math.random() * TENANT_CODE_ALPHABET.length)
    );
  }
  return out;
}

// POST /api/tenants — create a new group. If `code` is provided we use it
// as-is (uppercased) and 409 on collision; otherwise we auto-generate and
// retry on the rare unique-violation race.
app.post("/api/tenants", async (req, res) => {
  const { code: providedCode, name } = req.body ?? {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  const trimmedName = name.trim();

  if (providedCode != null) {
    if (typeof providedCode !== "string" || !providedCode.trim()) {
      return res.status(400).json({ error: "code must be a non-empty string" });
    }
    const code = providedCode.trim().toUpperCase();
    try {
      const dup = await pool.query(
        "SELECT id FROM tenants WHERE LOWER(code) = LOWER($1)",
        [code]
      );
      if (dup.rows.length > 0) return res.status(409).json({ error: "code_taken" });
      const ins = await pool.query(
        "INSERT INTO tenants (code, name) VALUES ($1, $2) RETURNING id, code, name, created_at",
        [code, trimmedName]
      );
      return res.status(201).json(ins.rows[0]);
    } catch (err: any) {
      // Race: another request inserted the same code after our SELECT.
      // Postgres raises 23505; surface as 409 to match the pre-check.
      if (err?.code === "23505") return res.status(409).json({ error: "code_taken" });
      console.error("[tenancy] create tenant failed:", err);
      return res.status(500).json({ error: "Failed to create tenant" });
    }
  }

  // Auto-generate — retry the handful of times it'd take to clear a collision.
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateTenantCode();
    try {
      const ins = await pool.query(
        "INSERT INTO tenants (code, name) VALUES ($1, $2) RETURNING id, code, name, created_at",
        [code, trimmedName]
      );
      return res.status(201).json(ins.rows[0]);
    } catch (err: any) {
      if (err?.code === "23505") continue;
      console.error("[tenancy] create tenant (auto-code) failed:", err);
      return res.status(500).json({ error: "Failed to create tenant" });
    }
  }
  return res.status(500).json({ error: "Failed to generate a unique tenant code" });
});

// GET /api/tenants/resolve?code=XXX — lightweight existence check used by
// the landing page BEFORE login. Returns {id, name} on hit, 404 otherwise.
app.get("/api/tenants/resolve", async (req, res) => {
  const code = (req.query.code as string | undefined)?.trim();
  if (!code) return res.status(400).json({ error: "code is required" });
  try {
    const result = await pool.query(
      "SELECT id, name FROM tenants WHERE LOWER(code) = LOWER($1)",
      [code]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "not_found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("[tenancy] resolve tenant failed:", err);
    res.status(500).json({ error: "Failed to resolve tenant" });
  }
});

// ===========================================================================
// ── FISHES ROUTES (tenant-scoped) ───────────────────────────────────────────
// ===========================================================================

// Resolve player name via alias (case-insensitive), scoped to tenant.
async function resolvePlayerName(client: any, tenantId: string, name: string): Promise<string> {
  const res = await client.query(
    `SELECT p.name FROM player_aliases pa
     JOIN players p ON pa.player_id = p.id
     WHERE LOWER(pa.alias) = LOWER($1) AND pa.tenant_id = $2`,
    [name.trim(), tenantId]
  );
  return res.rows.length > 0 ? res.rows[0].name : name.trim();
}

app.get("/api/players", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         p.id,
         p.name,
         (
           COALESCE((SELECT SUM(amount) FROM session_results
                      WHERE player_id = p.id AND tenant_id = $1), 0)
           + COALESCE((SELECT SUM(amount) FROM settlements
                        WHERE payer_id = p.id AND status = 'completed' AND tenant_id = $1), 0)
           - COALESCE((SELECT SUM(amount) FROM settlements
                        WHERE payee_id = p.id AND status = 'completed' AND tenant_id = $1), 0)
         ) AS total_profit
       FROM players p
       WHERE p.tenant_id = $1
       ORDER BY total_profit DESC`,
      [req.tenantId]
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch players" });
  }
});

// Per-player event history for the Leaderboard popup. Raw session_results
// and settlements rows are fetched here; sign flipping, "Settled with" /
// "Received from" phrasing, sort order, and the running total all live in
// api/lib/playerHistory.ts so a single unit-tested helper enforces the
// invariant `cumulative[last].total === /api/players.total_profit`.
app.get("/api/players/:id/history", async (req, res) => {
  const playerId = parseInt(req.params.id, 10);
  if (!Number.isFinite(playerId) || playerId <= 0) {
    return res.status(400).json({ error: "Invalid player id" });
  }
  try {
    const playerRes = await pool.query(
      "SELECT id, name FROM players WHERE id = $1 AND tenant_id = $2",
      [playerId, req.tenantId]
    );
    if (playerRes.rows.length === 0) {
      return res.status(404).json({ error: "Player not found" });
    }
    const sessionRes = await pool.query(
      `SELECT s.date, sr.amount::numeric AS amount, COALESCE(s.note, '') AS note
         FROM session_results sr
         JOIN sessions s ON sr.session_id = s.id
        WHERE sr.player_id = $1 AND sr.tenant_id = $2`,
      [playerId, req.tenantId]
    );
    const settleRes = await pool.query(
      `SELECT st.date, st.amount::numeric AS amount, st.status,
              'payer' AS role, payee.name AS counterparty_name
         FROM settlements st
         JOIN players payee ON st.payee_id = payee.id
        WHERE st.payer_id = $1 AND st.tenant_id = $2
       UNION ALL
       SELECT st.date, st.amount::numeric AS amount, st.status,
              'payee' AS role, payer.name AS counterparty_name
         FROM settlements st
         JOIN players payer ON st.payer_id = payer.id
        WHERE st.payee_id = $1 AND st.tenant_id = $2`,
      [playerId, req.tenantId]
    );

    const sessions: SessionResultRow[] = sessionRes.rows.map((r: any) => ({
      date: r.date,
      amount: parseFloat(r.amount),
      note: r.note,
    }));
    const settlements: SettlementRow[] = settleRes.rows.map((r: any) => ({
      date: r.date,
      amount: parseFloat(r.amount),
      status: r.status,
      role: r.role,
      counterpartyName: r.counterparty_name,
    }));

    const events = buildPlayerHistoryEvents(sessions, settlements);
    const cumulative = buildCumulative(events);

    res.json({
      player: playerRes.rows[0],
      events,
      cumulative,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch player history" });
  }
});

app.get("/api/sessions", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.date, s.note,
              COALESCE(
                json_agg(
                  json_build_object('name', p.name, 'amount', sr.amount)
                ) FILTER (WHERE sr.id IS NOT NULL),
                '[]'
              ) AS results
         FROM sessions s
         LEFT JOIN session_results sr ON sr.session_id = s.id AND sr.tenant_id = $1
         LEFT JOIN players p ON sr.player_id = p.id AND p.tenant_id = $1
        WHERE s.tenant_id = $1
        GROUP BY s.id
        ORDER BY s.date DESC`,
      [req.tenantId]
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

app.post("/api/sessions", async (req, res) => {
  const { date, note, results } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sessionRes = await client.query(
      "INSERT INTO sessions (date, note, tenant_id) VALUES ($1, $2, $3) RETURNING id",
      [date, note, req.tenantId]
    );
    const sessionId = sessionRes.rows[0].id;
    for (const result of results) {
      const resolvedName = await resolvePlayerName(client, req.tenantId!, result.name);
      // Per-tenant uniqueness: a player named "Alice" in tenant A must be
      // distinct from "Alice" in tenant B. The global `UNIQUE (name)`
      // constraint will be dropped in Phase 2; until then we rely on the
      // backfill having seeded all existing rows to OGFISH and tenants
      // being keyed off of that uniqueness. The SELECT-then-INSERT here
      // is deliberate so we never upsert across tenants.
      const existing = await client.query(
        "SELECT id FROM players WHERE tenant_id = $1 AND LOWER(name) = LOWER($2)",
        [req.tenantId, resolvedName]
      );
      let playerId: number;
      if (existing.rows.length > 0) {
        playerId = existing.rows[0].id;
      } else {
        const ins = await client.query(
          "INSERT INTO players (name, tenant_id) VALUES ($1, $2) RETURNING id",
          [resolvedName, req.tenantId]
        );
        playerId = ins.rows[0].id;
      }
      await client.query(
        "INSERT INTO session_results (session_id, player_id, amount, tenant_id) VALUES ($1, $2, $3, $4)",
        [sessionId, playerId, result.amount, req.tenantId]
      );
    }
    await client.query("COMMIT");
    res.json({ success: true, sessionId });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to save session" });
  } finally {
    client.release();
  }
});

app.delete("/api/sessions/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM session_results WHERE session_id = $1 AND tenant_id = $2",
      [req.params.id, req.tenantId]
    );
    await client.query(
      "DELETE FROM sessions WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.tenantId]
    );
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to delete session" });
  } finally {
    client.release();
  }
});

app.get("/api/settlements", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.amount, s.date, s.status,
              p1.name AS payer, p2.name AS payee
         FROM settlements s
         JOIN players p1 ON s.payer_id = p1.id
         JOIN players p2 ON s.payee_id = p2.id
        WHERE s.tenant_id = $1
        ORDER BY s.date DESC, s.id DESC`,
      [req.tenantId]
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch settlements" });
  }
});

app.post("/api/settlements", async (req, res) => {
  const { payer, payee, amount, date } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Upsert payer/payee scoped to this tenant. The SELECT-then-INSERT
    // pattern mirrors /api/sessions — we must never reach across tenants
    // when the global players.name UNIQUE index gets dropped in Phase 2.
    async function upsertPlayer(name: string): Promise<number> {
      const existing = await client.query(
        "SELECT id FROM players WHERE tenant_id = $1 AND LOWER(name) = LOWER($2)",
        [req.tenantId, name]
      );
      if (existing.rows.length > 0) return existing.rows[0].id;
      const ins = await client.query(
        "INSERT INTO players (name, tenant_id) VALUES ($1, $2) RETURNING id",
        [name, req.tenantId]
      );
      return ins.rows[0].id;
    }

    const payerId = await upsertPlayer(payer);
    const payeeId = await upsertPlayer(payee);

    // Cross-tenant guard: verify both players live in the caller's tenant.
    // With the upserts above this is a belt-and-braces check — but if the
    // client ever supplies numeric IDs in future this check catches it.
    const guard = await client.query(
      "SELECT id FROM players WHERE id IN ($1, $2) AND tenant_id = $3",
      [payerId, payeeId, req.tenantId]
    );
    if (guard.rows.length !== 2) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "cross_tenant_settlement" });
    }

    const settlementRes = await client.query(
      "INSERT INTO settlements (payer_id, payee_id, amount, date, status, tenant_id) VALUES ($1, $2, $3, $4, 'completed', $5) RETURNING id",
      [payerId, payeeId, amount, date, req.tenantId]
    );
    await client.query("COMMIT");
    res.json({ success: true, settlementId: settlementRes.rows[0].id });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to save settlement" });
  } finally {
    client.release();
  }
});

app.delete("/api/settlements/:id", async (req, res) => {
  try {
    await pool.query(
      "UPDATE settlements SET status = 'voided' WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.tenantId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to void settlement" });
  }
});

app.patch("/api/settlements/:id/restore", async (req, res) => {
  try {
    await pool.query(
      "UPDATE settlements SET status = 'completed' WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.tenantId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to restore settlement" });
  }
});

// Player alias management
app.get("/api/players/aliases", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.name,
              COALESCE(
                json_agg(json_build_object('id', pa.id, 'alias', pa.alias))
                FILTER (WHERE pa.id IS NOT NULL), '[]'
              ) AS aliases,
              COALESCE((SELECT SUM(sr.amount) FROM session_results sr
                         WHERE sr.player_id = p.id AND sr.tenant_id = $1), 0) AS session_profit
         FROM players p
         LEFT JOIN player_aliases pa ON pa.player_id = p.id AND pa.tenant_id = $1
        WHERE p.tenant_id = $1
        GROUP BY p.id
        ORDER BY p.name`,
      [req.tenantId]
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch player aliases" });
  }
});

app.post("/api/players/:id/aliases", async (req, res) => {
  const { alias } = req.body;
  if (!alias?.trim()) return res.status(400).json({ error: "Alias cannot be empty" });
  try {
    // Must not already match a different player's display name within
    // the same tenant — that would make alias resolution ambiguous.
    const existing = await pool.query(
      "SELECT id FROM players WHERE LOWER(name) = LOWER($1) AND tenant_id = $2",
      [alias.trim(), req.tenantId]
    );
    if (existing.rows.length > 0 && existing.rows[0].id !== parseInt(req.params.id)) {
      return res.status(409).json({
        error: `"${alias}" is already a player name. Merge them instead.`,
      });
    }
    // Guard: target player must belong to this tenant.
    const playerOwn = await pool.query(
      "SELECT id FROM players WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.tenantId]
    );
    if (playerOwn.rows.length === 0) {
      return res.status(404).json({ error: "Player not found" });
    }
    await pool.query(
      "INSERT INTO player_aliases (player_id, alias, tenant_id) VALUES ($1, $2, $3)",
      [req.params.id, alias.trim(), req.tenantId]
    );
    res.json({ success: true });
  } catch (error: any) {
    if (error?.code === "23505")
      return res.status(409).json({ error: "This alias is already mapped to a player." });
    console.error(error);
    res.status(500).json({ error: "Failed to add alias" });
  }
});

app.delete("/api/players/aliases/:aliasId", async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM player_aliases WHERE id = $1 AND tenant_id = $2",
      [req.params.aliasId, req.tenantId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to remove alias" });
  }
});

app.post("/api/players/merge", async (req, res) => {
  const { sourceId, targetId } = req.body;
  if (!sourceId || !targetId || sourceId === targetId)
    return res.status(400).json({ error: "Invalid merge parameters" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Both players must live in the caller's tenant — otherwise this is a
    // cross-tenant merge attempt and we reject outright.
    const own = await client.query(
      "SELECT id FROM players WHERE id IN ($1, $2) AND tenant_id = $3",
      [sourceId, targetId, req.tenantId]
    );
    if (own.rows.length !== 2) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "cross_tenant_merge" });
    }
    const srcRes = await client.query(
      "SELECT name FROM players WHERE id = $1 AND tenant_id = $2",
      [sourceId, req.tenantId]
    );
    if (srcRes.rows.length > 0) {
      await client.query(
        "INSERT INTO player_aliases (player_id, alias, tenant_id) VALUES ($1, $2, $3) ON CONFLICT (alias) DO NOTHING",
        [targetId, srcRes.rows[0].name, req.tenantId]
      );
    }
    await client.query(
      "UPDATE player_aliases SET player_id = $1 WHERE player_id = $2 AND tenant_id = $3",
      [targetId, sourceId, req.tenantId]
    );
    await client.query(
      "UPDATE session_results SET player_id = $1 WHERE player_id = $2 AND tenant_id = $3",
      [targetId, sourceId, req.tenantId]
    );
    await client.query(
      "UPDATE settlements SET payer_id = $1 WHERE payer_id = $2 AND tenant_id = $3",
      [targetId, sourceId, req.tenantId]
    );
    await client.query(
      "UPDATE settlements SET payee_id = $1 WHERE payee_id = $2 AND tenant_id = $3",
      [targetId, sourceId, req.tenantId]
    );
    await client.query(
      "DELETE FROM players WHERE id = $1 AND tenant_id = $2",
      [sourceId, req.tenantId]
    );
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to merge players" });
  } finally {
    client.release();
  }
});

app.delete("/api/players/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM player_aliases WHERE player_id = $1 AND tenant_id = $2",
      [req.params.id, req.tenantId]
    );
    await client.query(
      "DELETE FROM session_results WHERE player_id = $1 AND tenant_id = $2",
      [req.params.id, req.tenantId]
    );
    await client.query(
      "DELETE FROM settlements WHERE (payer_id = $1 OR payee_id = $1) AND tenant_id = $2",
      [req.params.id, req.tenantId]
    );
    await client.query(
      "DELETE FROM players WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.tenantId]
    );
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to delete player" });
  } finally {
    client.release();
  }
});

app.post("/api/reset", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Scoped reset: only wipes the calling tenant's rows, leaves others intact.
    await client.query("DELETE FROM session_results WHERE tenant_id = $1", [req.tenantId]);
    await client.query("DELETE FROM settlements     WHERE tenant_id = $1", [req.tenantId]);
    await client.query("DELETE FROM player_aliases  WHERE tenant_id = $1", [req.tenantId]);
    await client.query("DELETE FROM sessions        WHERE tenant_id = $1", [req.tenantId]);
    await client.query("DELETE FROM players         WHERE tenant_id = $1", [req.tenantId]);
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to reset data" });
  } finally {
    client.release();
  }
});

// AI extraction (Gemini) — stateless, no DB access, but still behind tenant
// middleware so the header roundtrip stays consistent on the frontend.
app.post("/api/extract", async (req, res) => {
  const { data, mimeType, isText } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    return res.status(500).json({ error: "Gemini API key is not configured on the server." });

  const ai = new GoogleGenAI({ apiKey });
  const prompt = `Extract player names and their profit/loss amounts from this poker session data.
Return a JSON array of objects with 'name' (string) and 'amount' (number, positive = profit, negative = loss).`;
  const parts: any[] = [{ text: prompt }];
  if (isText) {
    parts.push({ text: data });
  } else {
    const base64Data = data.includes(",") ? data.split(",")[1] : data;
    parts.push({ inlineData: { mimeType, data: base64Data } });
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name:   { type: Type.STRING },
              amount: { type: Type.NUMBER },
            },
            required: ["name", "amount"],
          },
        },
      },
    });
    res.json(JSON.parse(response.text || "[]"));
  } catch (error: any) {
    console.error("Gemini API Error:", error);
    const msg = error?.message || "";
    if (msg.includes("API key"))
      return res.status(401).json({ error: "Invalid or missing Gemini API key." });
    if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota"))
      return res.status(429).json({ error: "Gemini API rate limit exceeded. Please wait and try again." });
    res.status(500).json({ error: "Failed to process file with AI. Please try again." });
  }
});

// ===========================================================================
// ── LIVE (THOR) ROUTES — all under /api/live/ ───────────────────────────────
// ===========================================================================

// Short-circuit Live routes with 503 when the DB never initialised or has
// dropped. 503 (not 500) is the honest code for "backend dep dead" and lets
// the frontend distinguish a backend outage from a real bug.
app.use("/api/live", (_req, res, next) => {
  if (!dbReady) {
    return res.status(503).json({ error: "database unavailable" });
  }
  next();
});

// Helper: generate random 6-char alphanumeric session code
function generateCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ── Auth ────────────────────────────────────────────────────────────────────

app.post("/api/live/auth/register", async (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username || !password)
    return res.status(400).json({ error: "name, username and password are required" });
  try {
    // Username uniqueness is per-tenant — the same "alice" can register
    // in two different groups without collision.
    const dup = await pool.query(
      "SELECT id FROM live_users WHERE LOWER(username) = LOWER($1) AND tenant_id = $2",
      [username, req.tenantId]
    );
    if (dup.rows.length > 0)
      return res.status(409).json({ error: "Username already taken" });
    const result = await pool.query(
      "INSERT INTO live_users (name, username, password, tenant_id) VALUES ($1, $2, $3, $4) RETURNING id, name, username, mobile",
      [name.trim(), username.trim(), password, req.tenantId]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/live/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "username and password are required" });
  try {
    const result = await pool.query(
      "SELECT id, name, username, mobile FROM live_users WHERE LOWER(username) = LOWER($1) AND password = $2 AND tenant_id = $3",
      [username, password, req.tenantId]
    );
    if (result.rows.length === 0)
      return res.status(401).json({ error: "Invalid username or password" });
    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Login failed" });
  }
});

// ── Sessions ────────────────────────────────────────────────────────────────

app.get("/api/live/sessions", async (req, res) => {
  const { userId } = req.query as { userId?: string };
  try {
    let rows;
    if (userId) {
      // Return sessions the user participates in, scoped to tenant.
      const result = await pool.query(
        `SELECT DISTINCT ls.*
           FROM live_sessions ls
           LEFT JOIN live_session_players lsp ON ls.id = lsp.session_id AND lsp.tenant_id = $2
          WHERE (lsp.user_id = $1 OR ls.created_by = $1)
            AND ls.tenant_id = $2
          ORDER BY ls.created_at DESC`,
        [userId, req.tenantId]
      );
      rows = result.rows;
    } else {
      const result = await pool.query(
        "SELECT * FROM live_sessions WHERE tenant_id = $1 ORDER BY created_at DESC",
        [req.tenantId]
      );
      rows = result.rows;
    }
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch live sessions" });
  }
});

app.post("/api/live/sessions", async (req, res) => {
  const { name, blindValue, createdBy } = req.body;
  if (!name || !createdBy)
    return res.status(400).json({ error: "name and createdBy are required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const code = generateCode();
    const sessionRes = await client.query(
      `INSERT INTO live_sessions (name, session_code, blind_value, created_by, tenant_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name.trim(), code, blindValue || "10/20", createdBy, req.tenantId]
    );
    const session = sessionRes.rows[0];
    // Add creator as admin player
    await client.query(
      `INSERT INTO live_session_players (session_id, user_id, role, tenant_id)
       VALUES ($1, $2, 'admin', $3)`,
      [session.id, createdBy, req.tenantId]
    );
    await client.query("COMMIT");
    res.status(201).json(session);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to create live session" });
  } finally {
    client.release();
  }
});

// Publish a closed live session to the Fishes ledger. One-shot: inserts
// one Fishes `sessions` row plus one `session_results` row per player, then
// flips `published_to_ledger`/`published_session_id` on the live session so
// the button can't fire twice. All writes run inside a single transaction
// so a failure mid-way rolls the Fishes insert back and leaves the live
// session's published flag untouched.
app.post("/api/live/sessions/:id/publish", async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid session id" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Pull tenant_id alongside the session so we can cross-check against
    // req.tenantId BEFORE doing any write. Mismatch => 403. This is the
    // publish-to-ledger guard called out in the PR spec.
    const sessRes = await client.query(
      `SELECT id, name, status, closed_at, published_to_ledger, published_session_id, tenant_id
         FROM live_sessions WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (sessRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Session not found" });
    }
    const s = sessRes.rows[0];
    if (s.tenant_id !== req.tenantId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "cross_tenant_publish" });
    }

    const playersRes = await client.query(
      `SELECT lsp.user_id, lu.name, lsp.final_winnings
         FROM live_session_players lsp
         JOIN live_users lu ON lsp.user_id = lu.id
        WHERE lsp.session_id = $1 AND lsp.tenant_id = $2`,
      [id, req.tenantId]
    );
    const players: PublishPlayerInput[] = playersRes.rows.map((r: any) => ({
      userId: r.user_id,
      name: r.name,
      finalWinnings: r.final_winnings == null ? null : parseFloat(r.final_winnings),
    }));

    const buyInsRes = await client.query(
      `SELECT user_id, amount, status FROM live_buy_ins
        WHERE session_id = $1 AND tenant_id = $2`,
      [id, req.tenantId]
    );
    const buyIns: PublishBuyInInput[] = buyInsRes.rows.map((r: any) => ({
      userId: r.user_id,
      amount: parseFloat(r.amount),
      status: r.status,
    }));

    const validation = buildFishesPayload(
      {
        id: s.id,
        name: s.name,
        status: s.status,
        closedAt: s.closed_at,
        publishedToLedger: s.published_to_ledger,
        publishedSessionId: s.published_session_id,
      },
      players,
      buyIns
    );

    if (!validation.ok) {
      await client.query("ROLLBACK");
      const err = validation.error;
      if (err.code === "already_published") {
        return res
          .status(409)
          .json({ alreadyPublished: true, fishesSessionId: err.fishesSessionId });
      }
      return res.status(422).json({ error: err.message });
    }

    const { date, note, results } = validation.payload;
    const insertSession = await client.query(
      "INSERT INTO sessions (date, note, tenant_id) VALUES ($1, $2, $3) RETURNING id",
      [date, note, req.tenantId]
    );
    const fishesSessionId: number = insertSession.rows[0].id;

    for (const r of results) {
      const resolvedName = await resolvePlayerName(client, req.tenantId!, r.name);
      const existing = await client.query(
        "SELECT id FROM players WHERE tenant_id = $1 AND LOWER(name) = LOWER($2)",
        [req.tenantId, resolvedName]
      );
      let playerId: number;
      if (existing.rows.length > 0) {
        playerId = existing.rows[0].id;
      } else {
        const ins = await client.query(
          "INSERT INTO players (name, tenant_id) VALUES ($1, $2) RETURNING id",
          [resolvedName, req.tenantId]
        );
        playerId = ins.rows[0].id;
      }
      await client.query(
        "INSERT INTO session_results (session_id, player_id, amount, tenant_id) VALUES ($1, $2, $3, $4)",
        [fishesSessionId, playerId, r.amount, req.tenantId]
      );
    }

    await client.query(
      `UPDATE live_sessions
          SET published_to_ledger = TRUE, published_session_id = $1
        WHERE id = $2 AND tenant_id = $3`,
      [fishesSessionId, id, req.tenantId]
    );

    await client.query("COMMIT");
    res.json({ fishesSessionId });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to publish session" });
  } finally {
    client.release();
  }
});

// Specific session sub-routes MUST come before the /:idOrCode param route
app.post("/api/live/session/join", async (req, res) => {
  const { code, userId, role } = req.body;
  if (!code || !userId)
    return res.status(400).json({ error: "code and userId are required" });
  try {
    const sessRes = await pool.query(
      "SELECT * FROM live_sessions WHERE UPPER(session_code) = UPPER($1) AND tenant_id = $2",
      [code, req.tenantId]
    );
    if (sessRes.rows.length === 0)
      return res.status(404).json({ error: "Session code not found" });
    const session = sessRes.rows[0];
    if (session.status === "closed")
      return res.status(403).json({ error: "Session is closed" });

    // Check if already joined
    const existing = await pool.query(
      "SELECT * FROM live_session_players WHERE session_id = $1 AND user_id = $2 AND tenant_id = $3",
      [session.id, userId, req.tenantId]
    );
    if (existing.rows.length > 0) {
      const player = existing.rows[0];
      return res.status(200).json({ player, sessionId: session.id });
    }

    const playerRole = role || "player";
    const playerRes = await pool.query(
      `INSERT INTO live_session_players (session_id, user_id, role, tenant_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [session.id, userId, playerRole, req.tenantId]
    );
    res.status(201).json({ player: playerRes.rows[0], sessionId: session.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to join session" });
  }
});

app.post("/api/live/session/buyin", async (req, res) => {
  const { sessionId, userId, amount, status } = req.body;
  if (!sessionId || !userId || !amount)
    return res.status(400).json({ error: "sessionId, userId and amount are required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Auto-enroll as player if not already in session
    const existing = await client.query(
      "SELECT id FROM live_session_players WHERE session_id = $1 AND user_id = $2 AND tenant_id = $3",
      [sessionId, userId, req.tenantId]
    );
    if (existing.rows.length === 0) {
      await client.query(
        "INSERT INTO live_session_players (session_id, user_id, role, tenant_id) VALUES ($1, $2, 'player', $3)",
        [sessionId, userId, req.tenantId]
      );
    }
    const buyInStatus = status || "pending";
    const buyInRes = await client.query(
      `INSERT INTO live_buy_ins (session_id, user_id, amount, status, tenant_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [sessionId, userId, amount, buyInStatus, req.tenantId]
    );
    await client.query("COMMIT");
    res.status(201).json({ buyIn: buyInRes.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to create buy-in" });
  } finally {
    client.release();
  }
});

app.post("/api/live/session/settle", async (req, res) => {
  const { sessionId, userId, winnings } = req.body;
  if (!sessionId || !userId || winnings === undefined)
    return res.status(400).json({ error: "sessionId, userId and winnings are required" });
  try {
    const result = await pool.query(
      `UPDATE live_session_players
          SET final_winnings = $1
        WHERE session_id = $2 AND user_id = $3 AND tenant_id = $4
        RETURNING *`,
      [winnings, sessionId, userId, req.tenantId]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Player not found in session" });
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to record winnings" });
  }
});

app.post("/api/live/session/status", async (req, res) => {
  const { sessionId, status } = req.body;
  if (!sessionId || !status)
    return res.status(400).json({ error: "sessionId and status are required" });
  try {
    const result = await pool.query(
      `UPDATE live_sessions
          SET status = $1,
              closed_at = CASE WHEN $1 = 'closed' THEN NOW() ELSE closed_at END
        WHERE id = $2 AND tenant_id = $3
        RETURNING *`,
      [status, sessionId, req.tenantId]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Session not found" });
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update session status" });
  }
});

// Parameterized session route — after specific sub-routes
app.get("/api/live/session/:idOrCode", async (req, res) => {
  const { idOrCode } = req.params;
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrCode);
  try {
    const sessRes = await pool.query(
      isUUID
        ? "SELECT * FROM live_sessions WHERE id = $1 AND tenant_id = $2"
        : "SELECT * FROM live_sessions WHERE UPPER(session_code) = UPPER($1) AND tenant_id = $2",
      [idOrCode, req.tenantId]
    );
    if (sessRes.rows.length === 0)
      return res.status(404).json({ error: "Session not found" });
    const session = sessRes.rows[0];

    const playersRes = await pool.query(
      `SELECT lsp.*, lu.name
         FROM live_session_players lsp
         JOIN live_users lu ON lsp.user_id = lu.id
        WHERE lsp.session_id = $1 AND lsp.tenant_id = $2`,
      [session.id, req.tenantId]
    );

    const buyInsRes = await pool.query(
      `SELECT * FROM live_buy_ins
        WHERE session_id = $1 AND tenant_id = $2
        ORDER BY timestamp ASC`,
      [session.id, req.tenantId]
    );

    res.json({ session, players: playersRes.rows, buyIns: buyInsRes.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch session" });
  }
});

// Buy-in status update
app.patch("/api/live/buyin/:id", async (req, res) => {
  const { status } = req.body;
  if (!status)
    return res.status(400).json({ error: "status is required" });
  try {
    const result = await pool.query(
      "UPDATE live_buy_ins SET status = $1 WHERE id = $2 AND tenant_id = $3 RETURNING *",
      [status, req.params.id, req.tenantId]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Buy-in not found" });
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update buy-in" });
  }
});

// Per-user P&L stats
app.get("/api/live/stats/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const statsRes = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN ls.created_at >= NOW() - INTERVAL '7 days'
           THEN (COALESCE(lsp.final_winnings,0) - COALESCE(bi.total_buyin,0)) ELSE 0 END), 0) AS "weeklyPL",
         COALESCE(SUM(CASE WHEN ls.created_at >= NOW() - INTERVAL '30 days'
           THEN (COALESCE(lsp.final_winnings,0) - COALESCE(bi.total_buyin,0)) ELSE 0 END), 0) AS "monthlyPL",
         COALESCE(SUM(CASE WHEN ls.created_at >= NOW() - INTERVAL '365 days'
           THEN (COALESCE(lsp.final_winnings,0) - COALESCE(bi.total_buyin,0)) ELSE 0 END), 0) AS "yearlyPL",
         COALESCE(SUM(COALESCE(lsp.final_winnings,0) - COALESCE(bi.total_buyin,0)), 0) AS "totalPL"
       FROM live_session_players lsp
       JOIN live_sessions ls ON lsp.session_id = ls.id
       LEFT JOIN (
         SELECT session_id, user_id, SUM(amount) AS total_buyin
           FROM live_buy_ins
          WHERE status = 'approved' AND tenant_id = $2
          GROUP BY session_id, user_id
       ) bi ON bi.session_id = lsp.session_id AND bi.user_id = lsp.user_id
       WHERE lsp.user_id = $1 AND ls.status = 'closed'
         AND lsp.tenant_id = $2 AND ls.tenant_id = $2`,
      [userId, req.tenantId]
    );
    const stats = statsRes.rows[0] || {
      weeklyPL: 0, monthlyPL: 0, yearlyPL: 0, totalPL: 0,
    };

    const historyRes = await pool.query(
      `SELECT
         ls.id           AS session_id,
         ls.name         AS session_name,
         ls.created_at   AS session_date,
         COALESCE(lsp.final_winnings, 0)     AS final_winnings,
         COALESCE(bi.total_buyin, 0)         AS buyin_amount
       FROM live_session_players lsp
       JOIN live_sessions ls ON lsp.session_id = ls.id
       LEFT JOIN (
         SELECT session_id, user_id, SUM(amount) AS total_buyin
           FROM live_buy_ins
          WHERE status = 'approved' AND tenant_id = $2
          GROUP BY session_id, user_id
       ) bi ON bi.session_id = lsp.session_id AND bi.user_id = lsp.user_id
       WHERE lsp.user_id = $1 AND ls.status = 'closed'
         AND lsp.tenant_id = $2 AND ls.tenant_id = $2
       ORDER BY ls.created_at ASC`,
      [userId, req.tenantId]
    );
    const history = historyRes.rows.map((r: any) => ({
      sessionId: r.session_id,
      sessionName: r.session_name,
      date: new Date(r.session_date).getTime(),
      pl: parseFloat(r.final_winnings) - parseFloat(r.buyin_amount),
    }));

    res.json({ ...stats, history });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

export default app;
