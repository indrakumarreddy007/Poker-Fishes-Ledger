// ---------------------------------------------------------------------------
// Tenancy integration tests — covers the three representative endpoints
// called out in the PR spec: GET /api/players, POST /api/sessions,
// POST /api/settlements. For each we:
//   (a) confirm the middleware rejects a missing / bogus tenant code
//   (b) confirm a valid code lets through, but sees only its own rows
//
// We mock `pg.Pool` before importing api/index.ts so no real DB is
// needed. The mock models two tenants and records the tenant_id bound
// to each parameterized query so we can assert isolation.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';

// ── Fake Pool ───────────────────────────────────────────────────────────────
// Tracks every query issued so we can inspect `tenant_id` bindings. Also
// emulates the minimum handler set required by the endpoints under test:
//   - tenant code lookup in `tenants`
//   - players/sessions/settlements INSERT + SELECT, scoped to tenant_id

type Row = Record<string, any>;
interface QueryLog { text: string; values: any[]; }
const queryLog: QueryLog[] = [];

// Two tenants, pre-seeded.
const TENANT_A = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', code: 'ALPHA', name: 'Alpha Group' };
const TENANT_B = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', code: 'BETA',  name: 'Beta Group'  };

interface State {
  players: { id: number; name: string; tenant_id: string }[];
  nextPlayerId: number;
  sessions: { id: number; date: string; note: string | null; tenant_id: string }[];
  nextSessionId: number;
  session_results: { id: number; session_id: number; player_id: number; amount: number; tenant_id: string }[];
  nextSRId: number;
  settlements: { id: number; payer_id: number; payee_id: number; amount: number; date: string; status: string; tenant_id: string }[];
  nextSettlementId: number;
}

const state: State = {
  players: [],
  nextPlayerId: 1,
  sessions: [],
  nextSessionId: 1,
  session_results: [],
  nextSRId: 1,
  settlements: [],
  nextSettlementId: 1,
};

function resetState() {
  state.players = [];
  state.nextPlayerId = 1;
  state.sessions = [];
  state.nextSessionId = 1;
  state.session_results = [];
  state.nextSRId = 1;
  state.settlements = [];
  state.nextSettlementId = 1;
}

// Fake query executor. Matches on statement shape. Keep it minimal —
// we only need the statements the three tested endpoints actually emit.
async function fakeQuery(textInput: any, valuesInput?: any): Promise<{ rows: Row[] }> {
  // pg.Pool#query accepts either (text, values) or ({ text, values }). We
  // model the former since that's all api/index.ts uses.
  const text: string = typeof textInput === 'string' ? textInput : textInput?.text ?? '';
  const values: any[] = valuesInput ?? textInput?.values ?? [];
  queryLog.push({ text, values });

  // Normalise whitespace to make substring matches robust to formatting.
  const flat = text.replace(/\s+/g, ' ').trim().toLowerCase();

  // ── initDB DDL — swallow ───────────────────────────────────────────────
  if (flat.startsWith('create table') || flat.startsWith('alter table') ||
      flat.includes('create index')) {
    return { rows: [] };
  }

  // ── Transaction control — no-op ────────────────────────────────────────
  if (flat === 'begin' || flat === 'commit' || flat === 'rollback') {
    return { rows: [] };
  }

  // ── Tenant resolution SELECT ───────────────────────────────────────────
  if (flat.startsWith('select id from tenants where lower(code)')) {
    const code = String(values[0] ?? '').toUpperCase();
    const match = [TENANT_A, TENANT_B].find(t => t.code === code);
    return { rows: match ? [{ id: match.id }] : [] };
  }
  if (flat.startsWith('select id, name from tenants where lower(code)')) {
    const code = String(values[0] ?? '').toUpperCase();
    const match = [TENANT_A, TENANT_B].find(t => t.code === code);
    return { rows: match ? [{ id: match.id, name: match.name }] : [] };
  }

  // ── Players SELECT for /api/players ────────────────────────────────────
  if (flat.includes('from players p') && flat.includes('where p.tenant_id = $1')) {
    const tid = values[0];
    const rows = state.players
      .filter(p => p.tenant_id === tid)
      .map(p => {
        const sr = state.session_results
          .filter(r => r.player_id === p.id && r.tenant_id === tid)
          .reduce((s, r) => s + r.amount, 0);
        const paid = state.settlements
          .filter(s => s.payer_id === p.id && s.tenant_id === tid && s.status === 'completed')
          .reduce((s, x) => s + x.amount, 0);
        const recv = state.settlements
          .filter(s => s.payee_id === p.id && s.tenant_id === tid && s.status === 'completed')
          .reduce((s, x) => s + x.amount, 0);
        return { id: p.id, name: p.name, total_profit: sr + paid - recv };
      })
      .sort((a, b) => b.total_profit - a.total_profit);
    return { rows };
  }

  // ── SELECT-then-INSERT player upsert (sessions + settlements path) ─────
  if (flat.startsWith('select id from players where tenant_id = $1 and lower(name) = lower($2)')) {
    const [tid, name] = values;
    const hit = state.players.find(p => p.tenant_id === tid && p.name.toLowerCase() === String(name).toLowerCase());
    return { rows: hit ? [{ id: hit.id }] : [] };
  }
  if (flat.startsWith('insert into players (name, tenant_id) values ($1, $2) returning id')) {
    const [name, tid] = values;
    const row = { id: state.nextPlayerId++, name: String(name), tenant_id: String(tid) };
    state.players.push(row);
    return { rows: [{ id: row.id }] };
  }

  // Guard: SELECT id FROM players WHERE id IN ($1, $2) AND tenant_id = $3
  if (flat.startsWith('select id from players where id in ($1, $2) and tenant_id = $3')) {
    const [a, b, tid] = values;
    const rows = state.players.filter(p => (p.id === a || p.id === b) && p.tenant_id === tid).map(p => ({ id: p.id }));
    return { rows };
  }

  // ── Sessions INSERT ────────────────────────────────────────────────────
  if (flat.startsWith('insert into sessions (date, note, tenant_id) values ($1, $2, $3) returning id')) {
    const [date, note, tid] = values;
    const row = { id: state.nextSessionId++, date, note, tenant_id: tid };
    state.sessions.push(row);
    return { rows: [{ id: row.id }] };
  }

  // ── session_results INSERT ────────────────────────────────────────────
  if (flat.startsWith('insert into session_results (session_id, player_id, amount, tenant_id)')) {
    const [sid, pid, amt, tid] = values;
    const row = { id: state.nextSRId++, session_id: sid, player_id: pid, amount: amt, tenant_id: tid };
    state.session_results.push(row);
    return { rows: [] };
  }

  // ── Settlements INSERT ────────────────────────────────────────────────
  if (flat.includes("insert into settlements") && flat.includes('completed') && flat.includes('returning id')) {
    const [payerId, payeeId, amount, date, tid] = values;
    const row = {
      id: state.nextSettlementId++,
      payer_id: payerId,
      payee_id: payeeId,
      amount,
      date,
      status: 'completed',
      tenant_id: tid,
    };
    state.settlements.push(row);
    return { rows: [{ id: row.id }] };
  }

  // ── Aliases resolvePlayerName SELECT ───────────────────────────────────
  if (flat.includes('from player_aliases pa') && flat.includes('join players p on pa.player_id = p.id')) {
    return { rows: [] };
  }

  // Unknown query — return empty result so the handler usually errors out
  // in a visible way. Helpful for surfacing missing mock branches during
  // test development.
  return { rows: [] };
}

// Install the pg mock BEFORE importing api/index.ts.
vi.mock('pg', () => {
  class FakePool {
    on() { /* no-op */ }
    // Both pool.query(...) and client.query(...) route to the same fake.
    async query(text: any, values?: any) { return fakeQuery(text, values); }
    async connect() {
      return {
        query: async (text: any, values?: any) => fakeQuery(text, values),
        release: () => undefined,
      };
    }
  }
  return { Pool: FakePool };
});

// Import the app AFTER the mock is in place. Dynamic import so the mock
// order is deterministic.
let server: http.Server;
let baseUrl: string;
let __resetTenantCacheForTests: () => void;

beforeAll(async () => {
  const mod: any = await import('../api/index.ts');
  const app = mod.default as express.Express;
  __resetTenantCacheForTests = mod.__resetTenantCacheForTests;
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Thin fetch helper.
async function call(
  method: string,
  path: string,
  opts: { tenantCode?: string; body?: any } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.tenantCode !== undefined) headers['X-Tenant-Code'] = opts.tenantCode;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = undefined;
  try { body = text.length ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: res.status, body };
}

describe('tenancy integration — GET /api/players', () => {
  beforeAll(() => { resetState(); __resetTenantCacheForTests(); });

  it('rejects request with no tenant header (401 missing_tenant_code)', async () => {
    const r = await call('GET', '/api/players');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'missing_tenant_code' });
  });

  it('rejects request with bogus tenant code (401 invalid_tenant_code)', async () => {
    const r = await call('GET', '/api/players', { tenantCode: 'GHOST' });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'invalid_tenant_code' });
  });

  it('returns only the calling tenant\'s players', async () => {
    // Seed one player in each tenant via direct state (bypasses INSERT path).
    state.players.push({ id: 100, name: 'Alpha Alice', tenant_id: TENANT_A.id });
    state.players.push({ id: 200, name: 'Beta Bob',    tenant_id: TENANT_B.id });

    const a = await call('GET', '/api/players', { tenantCode: 'ALPHA' });
    expect(a.status).toBe(200);
    expect(a.body.map((p: any) => p.name)).toEqual(['Alpha Alice']);

    const b = await call('GET', '/api/players', { tenantCode: 'BETA' });
    expect(b.status).toBe(200);
    expect(b.body.map((p: any) => p.name)).toEqual(['Beta Bob']);
  });
});

describe('tenancy integration — POST /api/sessions', () => {
  beforeAll(() => { resetState(); __resetTenantCacheForTests(); });

  it('rejects with 401 when tenant code is missing', async () => {
    const r = await call('POST', '/api/sessions', {
      body: { date: '2026-04-20', note: 'x', results: [] },
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('missing_tenant_code');
  });

  it('rejects with 401 when tenant code is invalid', async () => {
    const r = await call('POST', '/api/sessions', {
      tenantCode: 'WRONG',
      body: { date: '2026-04-20', note: 'x', results: [] },
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('invalid_tenant_code');
  });

  it('writes session + results with the caller\'s tenant_id, not any other', async () => {
    queryLog.length = 0;
    const r = await call('POST', '/api/sessions', {
      tenantCode: 'ALPHA',
      body: {
        date: '2026-04-20',
        note: 'Friday',
        results: [{ name: 'Alice', amount: 300 }],
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);

    // Every sessions / session_results / players INSERT must have bound
    // TENANT_A.id — never TENANT_B.id and never missing.
    const inserts = queryLog.filter(q =>
      /insert\s+into\s+(sessions|session_results|players)/i.test(q.text)
    );
    expect(inserts.length).toBeGreaterThan(0);
    for (const q of inserts) {
      expect(q.values).toContain(TENANT_A.id);
      expect(q.values).not.toContain(TENANT_B.id);
    }
  });
});

describe('tenancy integration — POST /api/settlements', () => {
  beforeAll(() => { resetState(); __resetTenantCacheForTests(); });

  it('401s when the tenant header is missing', async () => {
    const r = await call('POST', '/api/settlements', {
      body: { payer: 'x', payee: 'y', amount: 1, date: '2026-04-20' },
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('missing_tenant_code');
  });

  it('401s when the tenant header is an unknown code', async () => {
    const r = await call('POST', '/api/settlements', {
      tenantCode: 'NOPE',
      body: { payer: 'x', payee: 'y', amount: 1, date: '2026-04-20' },
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('invalid_tenant_code');
  });

  it('happy path stamps settlement and players with caller\'s tenant_id', async () => {
    const r = await call('POST', '/api/settlements', {
      tenantCode: 'ALPHA',
      body: { payer: 'Pat', payee: 'Pam', amount: 50, date: '2026-04-20' },
    });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);

    // Settlement row must be stamped with TENANT_A.id.
    const last = state.settlements[state.settlements.length - 1];
    expect(last.tenant_id).toBe(TENANT_A.id);
    // Players upserted along the way must also be TENANT_A.
    const alphaPlayers = state.players.filter(p => p.tenant_id === TENANT_A.id);
    expect(alphaPlayers.map(p => p.name)).toEqual(expect.arrayContaining(['Pat', 'Pam']));
  });

  it('cross-tenant guard query runs and binds caller\'s tenant_id', async () => {
    resetState();
    __resetTenantCacheForTests();
    queryLog.length = 0;
    await call('POST', '/api/settlements', {
      tenantCode: 'ALPHA',
      body: { payer: 'Guard1', payee: 'Guard2', amount: 10, date: '2026-04-20' },
    });
    // The cross-tenant guard is a SELECT id FROM players WHERE id IN ($1,$2)
    // AND tenant_id = $3 — confirm it ran and its 3rd param was ALPHA.
    const guardQueries = queryLog.filter(q =>
      /from players where id in \(\$1, \$2\) and tenant_id = \$3/i.test(q.text)
    );
    expect(guardQueries.length).toBeGreaterThanOrEqual(1);
    expect(guardQueries[0].values[2]).toBe(TENANT_A.id);
  });
});

describe('tenancy integration — exempt routes', () => {
  it('GET /api/health answers without a tenant header', async () => {
    const r = await call('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
  });

  it('GET /api/tenants/resolve returns tenant on valid code, 404 on unknown', async () => {
    const good = await call('GET', '/api/tenants/resolve?code=ALPHA');
    expect(good.status).toBe(200);
    expect(good.body).toMatchObject({ id: TENANT_A.id, name: 'Alpha Group' });

    const bad = await call('GET', '/api/tenants/resolve?code=NOPE');
    expect(bad.status).toBe(404);
  });
});
