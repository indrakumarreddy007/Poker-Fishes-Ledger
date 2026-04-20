// ---------------------------------------------------------------------------
// liveApi — Thor live-session feature API client
// All routes are under /api/live/ to avoid colliding with Fishes routes.
// ---------------------------------------------------------------------------

const BASE = '/api/live';

// ── Types ───────────────────────────────────────────────────────────────────

export interface LiveUser {
  id: string;
  name: string;
  username: string;
  mobile?: string;
}

export interface LiveSession {
  id: string;
  name: string;
  sessionCode: string;
  createdBy: string;
  status: 'active' | 'closed';
  createdAt: number;
  closedAt?: number;
  blindValue?: string;
  publishedToLedger: boolean;
  publishedSessionId: number | null;
}

export interface LiveSessionPlayer {
  sessionId: string;
  userId: string;
  name: string;
  role: 'admin' | 'player';
  finalWinnings?: number;
}

export interface LiveBuyIn {
  id: string;
  sessionId: string;
  userId: string;
  amount: number;
  status: 'pending' | 'approved' | 'rejected';
  timestamp: number;
}

export interface LiveSessionPLPoint {
  sessionId: string;
  sessionName: string;
  date: number;
  pl: number;
}

export interface LivePlayerStats {
  weeklyPL: number;
  monthlyPL: number;
  yearlyPL: number;
  totalPL: number;
  history?: LiveSessionPLPoint[];
}

export interface LiveSettlementTx {
  from: string;
  to: string;
  amount: number;
}

// ── Mappers ─────────────────────────────────────────────────────────────────

const mapUser = (u: any): LiveUser => ({
  id: u.id,
  name: u.name,
  username: u.username,
  mobile: u.mobile,
});

const mapSession = (s: any): LiveSession => ({
  id: s.id,
  name: s.name,
  sessionCode: s.session_code,
  createdBy: s.created_by,
  status: s.status,
  createdAt: new Date(s.created_at).getTime(),
  closedAt: s.closed_at ? new Date(s.closed_at).getTime() : undefined,
  blindValue: s.blind_value,
  publishedToLedger: s.published_to_ledger === true,
  publishedSessionId:
    s.published_session_id == null ? null : Number(s.published_session_id),
});

const mapPlayer = (p: any): LiveSessionPlayer => ({
  sessionId: p.session_id,
  userId: p.user_id,
  name: p.name,
  role: p.role,
  finalWinnings: p.final_winnings != null ? parseFloat(p.final_winnings) : undefined,
});

const mapBuyIn = (b: any): LiveBuyIn => ({
  id: b.id,
  sessionId: b.session_id,
  userId: b.user_id,
  amount: parseFloat(b.amount),
  status: b.status,
  timestamp: new Date(b.timestamp).getTime(),
});

// ── Tenant-header helpers ────────────────────────────────────────────────────
//
// Every request made by this client must carry X-Tenant-Code. The header
// is sourced from localStorage ('tenantCode'), which Engineer C's landing
// page writes after the user picks a group. If the server rejects the code
// as missing or invalid we clear the stored code and reload — reload is
// the minimum we can do without knowing the React router; the landing
// page will then take over.
//
// In non-browser contexts (SSR, unit tests) localStorage is undefined;
// the helpers return an empty string which means the server will reject
// with missing_tenant_code and the caller gets a clean error.

function getTenantCode(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem('tenantCode') || '';
}

function tenantHeaders(extra?: Record<string, string>): Record<string, string> {
  const code = getTenantCode();
  const headers: Record<string, string> = { ...(extra || {}) };
  if (code) headers['X-Tenant-Code'] = code;
  return headers;
}

function clearTenantAndReload(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('tenantCode');
  }
  if (typeof window !== 'undefined') {
    window.location.reload();
  }
}

// Centralised tenant-error handling. A 401 with missing_tenant_code or
// invalid_tenant_code means the cached code in localStorage is gone or
// wrong — wipe it and reload so the landing page runs the flow again.
function maybeHandleTenantError(status: number, body: any): boolean {
  if (status !== 401) return false;
  const err = body?.error;
  if (err === 'missing_tenant_code' || err === 'invalid_tenant_code') {
    clearTenantAndReload();
    return true;
  }
  return false;
}

// ── Generic fetch helper ─────────────────────────────────────────────────────

async function apiFetch<T>(
  url: string,
  options?: RequestInit
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    // Merge X-Tenant-Code into whatever headers the caller passed. We do
    // this inside apiFetch (rather than expecting each call site to add
    // it) so adding the tenant to the protocol stays a single-line change
    // even as the number of endpoints grows.
    const mergedHeaders = tenantHeaders(
      (options?.headers as Record<string, string>) || undefined
    );
    const res = await fetch(url, { ...options, headers: mergedHeaders });
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (!res.ok) {
        maybeHandleTenantError(res.status, data);
        return { ok: false, error: data.error || `Error ${res.status}` };
      }
      return { ok: true, data };
    }
    const text = await res.text();
    return { ok: false, error: `Server error (${res.status}): ${text.slice(0, 120)}` };
  } catch (e: any) {
    return { ok: false, error: `Network error: ${e.message}` };
  }
}

// Thin wrapper for the handful of call sites that still use raw fetch
// (they want Response, not the apiFetch envelope). Centralises header
// injection and tenant-error handling in one place.
async function tenantFetch(url: string, options?: RequestInit): Promise<Response> {
  const mergedHeaders = tenantHeaders(
    (options?.headers as Record<string, string>) || undefined
  );
  const res = await fetch(url, { ...options, headers: mergedHeaders });
  if (res.status === 401) {
    // Peek at the body without consuming it for downstream callers. We
    // clone so the original response is still readable.
    try {
      const peek = await res.clone().json();
      maybeHandleTenantError(res.status, peek);
    } catch {
      // Non-JSON 401 — leave it alone; probably not from our middleware.
    }
  }
  return res;
}

// ── API object ───────────────────────────────────────────────────────────────

export const liveApi = {
  // Auth
  register: async (
    name: string,
    username: string,
    password: string
  ): Promise<{ success: boolean; user?: LiveUser; error?: string }> => {
    const r = await apiFetch<{ user: any }>(`${BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, username, password }),
    });
    if (!r.ok) return { success: false, error: r.error };
    return { success: true, user: mapUser(r.data.user) };
  },

  login: async (
    username: string,
    password: string
  ): Promise<{ success: boolean; user?: LiveUser; error?: string }> => {
    const r = await apiFetch<{ user: any }>(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) return { success: false, error: r.error };
    return { success: true, user: mapUser(r.data.user) };
  },

  // Sessions
  getSessions: async (userId: string): Promise<LiveSession[]> => {
    const res = await tenantFetch(`${BASE}/sessions?userId=${encodeURIComponent(userId)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.map(mapSession);
  },

  createSession: async (
    name: string,
    blindValue: string,
    createdBy: string
  ): Promise<{ success: boolean; session?: LiveSession; error?: string }> => {
    const r = await apiFetch<any>(`${BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, blindValue, createdBy }),
    });
    if (!r.ok) return { success: false, error: r.error };
    return { success: true, session: mapSession(r.data) };
  },

  getSession: async (
    idOrCode: string
  ): Promise<{ session: LiveSession; players: LiveSessionPlayer[]; buyIns: LiveBuyIn[] } | null> => {
    const res = await tenantFetch(`${BASE}/session/${encodeURIComponent(idOrCode)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      session: mapSession(data.session),
      players: data.players.map(mapPlayer),
      buyIns: data.buyIns.map(mapBuyIn),
    };
  },

  joinSession: async (
    code: string,
    userId: string,
    role: 'admin' | 'player' = 'player'
  ): Promise<{ success: boolean; error?: string; player?: LiveSessionPlayer; sessionId?: string }> => {
    const r = await apiFetch<{ player: any; sessionId: string }>(`${BASE}/session/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, userId, role }),
    });
    if (!r.ok) return { success: false, error: r.error };
    return { success: true, player: mapPlayer(r.data.player), sessionId: r.data.sessionId };
  },

  requestBuyIn: async (
    sessionId: string,
    userId: string,
    amount: number,
    status: 'pending' | 'approved' = 'pending'
  ): Promise<{ success: boolean; error?: string; buyIn?: LiveBuyIn }> => {
    const r = await apiFetch<{ buyIn: any }>(`${BASE}/session/buyin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, userId, amount, status }),
    });
    if (!r.ok) return { success: false, error: r.error };
    return { success: true, buyIn: mapBuyIn(r.data.buyIn) };
  },

  updateBuyInStatus: async (
    buyInId: string,
    status: 'pending' | 'approved' | 'rejected'
  ): Promise<boolean> => {
    const res = await tenantFetch(`${BASE}/buyin/${buyInId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    return res.ok;
  },

  updateSessionStatus: async (
    sessionId: string,
    status: 'active' | 'closed'
  ): Promise<boolean> => {
    const res = await tenantFetch(`${BASE}/session/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, status }),
    });
    return res.ok;
  },

  settlePlayer: async (
    sessionId: string,
    userId: string,
    winnings: number
  ): Promise<boolean> => {
    const res = await tenantFetch(`${BASE}/session/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, userId, winnings }),
    });
    return res.ok;
  },

  publishToLedger: async (
    sessionId: string
  ): Promise<
    | { success: true; fishesSessionId: number; alreadyPublished?: boolean }
    | { success: false; error: string }
  > => {
    const res = await tenantFetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const contentType = res.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await res.json() : {};
    if (res.status === 409 && body.alreadyPublished) {
      return {
        success: true,
        fishesSessionId: Number(body.fishesSessionId) || 0,
        alreadyPublished: true,
      };
    }
    if (!res.ok) {
      return { success: false, error: body.error || `Publish failed (${res.status})` };
    }
    return { success: true, fishesSessionId: Number(body.fishesSessionId) };
  },

  getUserStats: async (userId: string): Promise<LivePlayerStats> => {
    const res = await tenantFetch(`${BASE}/stats/${encodeURIComponent(userId)}`);
    if (!res.ok) return { weeklyPL: 0, monthlyPL: 0, yearlyPL: 0, totalPL: 0, history: [] };
    const data = await res.json();
    const history: LiveSessionPLPoint[] = Array.isArray(data.history)
      ? data.history.map((h: any) => ({
          sessionId: h.sessionId,
          sessionName: h.sessionName,
          date: typeof h.date === 'number' ? h.date : new Date(h.date).getTime(),
          pl: typeof h.pl === 'number' ? h.pl : parseFloat(h.pl),
        }))
      : [];
    return {
      weeklyPL: Number(data.weeklyPL) || 0,
      monthlyPL: Number(data.monthlyPL) || 0,
      yearlyPL: Number(data.yearlyPL) || 0,
      totalPL: Number(data.totalPL) || 0,
      history,
    };
  },
};
