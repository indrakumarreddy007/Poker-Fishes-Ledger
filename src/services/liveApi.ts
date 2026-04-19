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

// ── Generic fetch helper ─────────────────────────────────────────────────────

async function apiFetch<T>(
  url: string,
  options?: RequestInit
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, options);
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || `Error ${res.status}` };
      return { ok: true, data };
    }
    const text = await res.text();
    return { ok: false, error: `Server error (${res.status}): ${text.slice(0, 120)}` };
  } catch (e: any) {
    return { ok: false, error: `Network error: ${e.message}` };
  }
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
    const res = await fetch(`${BASE}/sessions?userId=${encodeURIComponent(userId)}`);
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
    const res = await fetch(`${BASE}/session/${encodeURIComponent(idOrCode)}`);
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
    const res = await fetch(`${BASE}/buyin/${buyInId}`, {
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
    const res = await fetch(`${BASE}/session/status`, {
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
    const res = await fetch(`${BASE}/session/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, userId, winnings }),
    });
    return res.ok;
  },

  getUserStats: async (userId: string): Promise<LivePlayerStats> => {
    const res = await fetch(`${BASE}/stats/${encodeURIComponent(userId)}`);
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
