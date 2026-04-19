import express from "express";
import { Pool } from "pg";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "20mb" }));

// Treat loopback and common dev hosts as local (no SSL). Public hosts get SSL.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "host.docker.internal"];
const isLocalDb = LOCAL_HOSTS.some((h) => process.env.DATABASE_URL?.includes(h));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

// Surface pool-level errors (e.g. idle client disconnects) without crashing the
// process. Without this handler, emitted 'error' events on the Pool become
// uncaught exceptions.
pool.on("error", (err) => {
  console.error("[db] pool error:", err.message);
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

      CREATE INDEX IF NOT EXISTS idx_live_sessions_code   ON live_sessions(session_code);
      CREATE INDEX IF NOT EXISTS idx_live_buy_ins_session ON live_buy_ins(session_id);
      CREATE INDEX IF NOT EXISTS idx_live_sp_session      ON live_session_players(session_id);
      CREATE INDEX IF NOT EXISTS idx_live_sp_user         ON live_session_players(user_id);
    `);
  } catch (err) {
    // Keep the server process alive even when Postgres is unreachable at
    // boot. Routes that need the DB will still fail with 500s, but at least
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
// ── FISHES ROUTES (unchanged) ───────────────────────────────────────────────
// ===========================================================================

// Resolve player name via alias (case-insensitive)
async function resolvePlayerName(client: any, name: string): Promise<string> {
  const res = await client.query(
    `SELECT p.name FROM player_aliases pa
     JOIN players p ON pa.player_id = p.id
     WHERE LOWER(pa.alias) = LOWER($1)`,
    [name.trim()]
  );
  return res.rows.length > 0 ? res.rows[0].name : name.trim();
}

app.get("/api/players", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.id,
        p.name,
        (
          COALESCE((SELECT SUM(amount) FROM session_results WHERE player_id = p.id), 0)
          + COALESCE((SELECT SUM(amount) FROM settlements WHERE payer_id = p.id AND status = 'completed'), 0)
          - COALESCE((SELECT SUM(amount) FROM settlements WHERE payee_id = p.id AND status = 'completed'), 0)
        ) AS total_profit
      FROM players p
      ORDER BY total_profit DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch players" });
  }
});

app.get("/api/sessions", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id, s.date, s.note,
             COALESCE(
               json_agg(
                 json_build_object('name', p.name, 'amount', sr.amount)
               ) FILTER (WHERE sr.id IS NOT NULL),
               '[]'
             ) AS results
      FROM sessions s
      LEFT JOIN session_results sr ON sr.session_id = s.id
      LEFT JOIN players p ON sr.player_id = p.id
      GROUP BY s.id
      ORDER BY s.date DESC
    `);
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
      "INSERT INTO sessions (date, note) VALUES ($1, $2) RETURNING id",
      [date, note]
    );
    const sessionId = sessionRes.rows[0].id;
    for (const result of results) {
      const resolvedName = await resolvePlayerName(client, result.name);
      const playerRes = await client.query(
        "INSERT INTO players (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
        [resolvedName]
      );
      await client.query(
        "INSERT INTO session_results (session_id, player_id, amount) VALUES ($1, $2, $3)",
        [sessionId, playerRes.rows[0].id, result.amount]
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
    await client.query("DELETE FROM session_results WHERE session_id = $1", [req.params.id]);
    await client.query("DELETE FROM sessions WHERE id = $1", [req.params.id]);
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
    const { rows } = await pool.query(`
      SELECT s.id, s.amount, s.date, s.status,
             p1.name AS payer, p2.name AS payee
      FROM settlements s
      JOIN players p1 ON s.payer_id = p1.id
      JOIN players p2 ON s.payee_id = p2.id
      ORDER BY s.date DESC, s.id DESC
    `);
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
    const payerRes = await client.query(
      "INSERT INTO players (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      [payer]
    );
    const payeeRes = await client.query(
      "INSERT INTO players (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      [payee]
    );
    const settlementRes = await client.query(
      "INSERT INTO settlements (payer_id, payee_id, amount, date, status) VALUES ($1, $2, $3, $4, 'completed') RETURNING id",
      [payerRes.rows[0].id, payeeRes.rows[0].id, amount, date]
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
    await pool.query("UPDATE settlements SET status = 'voided' WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to void settlement" });
  }
});

app.patch("/api/settlements/:id/restore", async (req, res) => {
  try {
    await pool.query("UPDATE settlements SET status = 'completed' WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to restore settlement" });
  }
});

// Player alias management
app.get("/api/players/aliases", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.id, p.name,
        COALESCE(
          json_agg(json_build_object('id', pa.id, 'alias', pa.alias))
          FILTER (WHERE pa.id IS NOT NULL), '[]'
        ) AS aliases,
        COALESCE((SELECT SUM(sr.amount) FROM session_results sr WHERE sr.player_id = p.id), 0) AS session_profit
      FROM players p
      LEFT JOIN player_aliases pa ON pa.player_id = p.id
      GROUP BY p.id
      ORDER BY p.name
    `);
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
    const existing = await pool.query(
      "SELECT id FROM players WHERE LOWER(name) = LOWER($1)",
      [alias.trim()]
    );
    if (existing.rows.length > 0 && existing.rows[0].id !== parseInt(req.params.id)) {
      return res.status(409).json({
        error: `"${alias}" is already a player name. Merge them instead.`,
      });
    }
    await pool.query(
      "INSERT INTO player_aliases (player_id, alias) VALUES ($1, $2)",
      [req.params.id, alias.trim()]
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
    await pool.query("DELETE FROM player_aliases WHERE id = $1", [req.params.aliasId]);
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
    const srcRes = await client.query("SELECT name FROM players WHERE id = $1", [sourceId]);
    if (srcRes.rows.length > 0) {
      await client.query(
        "INSERT INTO player_aliases (player_id, alias) VALUES ($1, $2) ON CONFLICT (alias) DO NOTHING",
        [targetId, srcRes.rows[0].name]
      );
    }
    await client.query("UPDATE player_aliases SET player_id = $1 WHERE player_id = $2", [targetId, sourceId]);
    await client.query("UPDATE session_results SET player_id = $1 WHERE player_id = $2", [targetId, sourceId]);
    await client.query("UPDATE settlements SET payer_id = $1 WHERE payer_id = $2", [targetId, sourceId]);
    await client.query("UPDATE settlements SET payee_id = $1 WHERE payee_id = $2", [targetId, sourceId]);
    await client.query("DELETE FROM players WHERE id = $1", [sourceId]);
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
    await client.query("DELETE FROM player_aliases WHERE player_id = $1", [req.params.id]);
    await client.query("DELETE FROM session_results WHERE player_id = $1", [req.params.id]);
    await client.query("DELETE FROM settlements WHERE payer_id = $1 OR payee_id = $1", [req.params.id]);
    await client.query("DELETE FROM players WHERE id = $1", [req.params.id]);
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
    await client.query("DELETE FROM session_results");
    await client.query("DELETE FROM settlements");
    await client.query("DELETE FROM player_aliases");
    await client.query("DELETE FROM sessions");
    await client.query("DELETE FROM players");
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

// AI extraction (Gemini)
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
    const dup = await pool.query(
      "SELECT id FROM live_users WHERE LOWER(username) = LOWER($1)",
      [username]
    );
    if (dup.rows.length > 0)
      return res.status(409).json({ error: "Username already taken" });
    const result = await pool.query(
      "INSERT INTO live_users (name, username, password) VALUES ($1, $2, $3) RETURNING id, name, username, mobile",
      [name.trim(), username.trim(), password]
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
      "SELECT id, name, username, mobile FROM live_users WHERE LOWER(username) = LOWER($1) AND password = $2",
      [username, password]
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
      // Return sessions the user participates in
      const result = await pool.query(
        `SELECT DISTINCT ls.*
         FROM live_sessions ls
         LEFT JOIN live_session_players lsp ON ls.id = lsp.session_id
         WHERE lsp.user_id = $1 OR ls.created_by = $1
         ORDER BY ls.created_at DESC`,
        [userId]
      );
      rows = result.rows;
    } else {
      const result = await pool.query(
        "SELECT * FROM live_sessions ORDER BY created_at DESC"
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
      `INSERT INTO live_sessions (name, session_code, blind_value, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name.trim(), code, blindValue || "10/20", createdBy]
    );
    const session = sessionRes.rows[0];
    // Add creator as admin player
    await client.query(
      `INSERT INTO live_session_players (session_id, user_id, role)
       VALUES ($1, $2, 'admin')`,
      [session.id, createdBy]
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

// Specific session sub-routes MUST come before the /:idOrCode param route
app.post("/api/live/session/join", async (req, res) => {
  const { code, userId, role } = req.body;
  if (!code || !userId)
    return res.status(400).json({ error: "code and userId are required" });
  try {
    const sessRes = await pool.query(
      "SELECT * FROM live_sessions WHERE UPPER(session_code) = UPPER($1)",
      [code]
    );
    if (sessRes.rows.length === 0)
      return res.status(404).json({ error: "Session code not found" });
    const session = sessRes.rows[0];
    if (session.status === "closed")
      return res.status(403).json({ error: "Session is closed" });

    // Check if already joined
    const existing = await pool.query(
      "SELECT * FROM live_session_players WHERE session_id = $1 AND user_id = $2",
      [session.id, userId]
    );
    if (existing.rows.length > 0) {
      const player = existing.rows[0];
      return res.status(200).json({ player, sessionId: session.id });
    }

    const playerRole = role || "player";
    const playerRes = await pool.query(
      `INSERT INTO live_session_players (session_id, user_id, role)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [session.id, userId, playerRole]
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
      "SELECT id FROM live_session_players WHERE session_id = $1 AND user_id = $2",
      [sessionId, userId]
    );
    if (existing.rows.length === 0) {
      await client.query(
        "INSERT INTO live_session_players (session_id, user_id, role) VALUES ($1, $2, 'player')",
        [sessionId, userId]
      );
    }
    const buyInStatus = status || "pending";
    const buyInRes = await client.query(
      `INSERT INTO live_buy_ins (session_id, user_id, amount, status)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [sessionId, userId, amount, buyInStatus]
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
       WHERE session_id = $2 AND user_id = $3
       RETURNING *`,
      [winnings, sessionId, userId]
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
       WHERE id = $2
       RETURNING *`,
      [status, sessionId]
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
        ? "SELECT * FROM live_sessions WHERE id = $1"
        : "SELECT * FROM live_sessions WHERE UPPER(session_code) = UPPER($1)",
      [idOrCode]
    );
    if (sessRes.rows.length === 0)
      return res.status(404).json({ error: "Session not found" });
    const session = sessRes.rows[0];

    const playersRes = await pool.query(
      `SELECT lsp.*, lu.name
       FROM live_session_players lsp
       JOIN live_users lu ON lsp.user_id = lu.id
       WHERE lsp.session_id = $1`,
      [session.id]
    );

    const buyInsRes = await pool.query(
      `SELECT * FROM live_buy_ins
       WHERE session_id = $1
       ORDER BY timestamp ASC`,
      [session.id]
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
      "UPDATE live_buy_ins SET status = $1 WHERE id = $2 RETURNING *",
      [status, req.params.id]
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
    const result = await pool.query(
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
         FROM live_buy_ins WHERE status = 'approved'
         GROUP BY session_id, user_id
       ) bi ON bi.session_id = lsp.session_id AND bi.user_id = lsp.user_id
       WHERE lsp.user_id = $1 AND ls.status = 'closed'`,
      [userId]
    );
    res.json(result.rows[0] || { weeklyPL: 0, monthlyPL: 0, yearlyPL: 0, totalPL: 0 });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

export default app;
