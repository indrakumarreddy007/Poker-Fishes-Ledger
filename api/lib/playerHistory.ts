export interface HistoryEventRow {
  date: string;
  kind: 'session' | 'settlement';
  delta: number;
  note: string;
}

export interface CumulativePoint {
  date: string;
  total: number;
}

// Fixture shapes that mirror the /api/players leaderboard query inputs.
// Used both by the endpoint (after SQL) and by tests (as synthetic data) to
// prove the chart's cumulative sum equals the leaderboard's total_profit.
export interface SessionResultRow {
  date: string;
  amount: number;
  note: string;
}

export interface SettlementRow {
  date: string;
  amount: number;
  status: string;
  role: 'payer' | 'payee';
  counterpartyName: string;
}

// Event builder: UNION session_results + settlements into the event stream.
// Signs must match the /api/players leaderboard formula:
//   total_profit = sum(session_results.amount)
//                + sum(settlements where I'm payer and status='completed')
//                - sum(settlements where I'm payee and status='completed')
// i.e. paying a debt improves outstanding P/L (+), receiving a payoff
// realizes outstanding credit (-). Reversing this breaks the invariant and
// the popup number stops matching the leaderboard row it sits behind.
export function buildPlayerHistoryEvents(
  sessionResults: SessionResultRow[],
  settlements: SettlementRow[]
): HistoryEventRow[] {
  const events: HistoryEventRow[] = [];

  for (const sr of sessionResults) {
    events.push({
      date: sr.date,
      kind: 'session',
      delta: sr.amount,
      note: sr.note ?? '',
    });
  }
  for (const st of settlements) {
    if (st.status !== 'completed') continue;
    if (st.role === 'payer') {
      events.push({
        date: st.date,
        kind: 'settlement',
        delta: st.amount,
        note: `Settled with ${st.counterpartyName}`,
      });
    } else {
      events.push({
        date: st.date,
        kind: 'settlement',
        delta: -st.amount,
        note: `Received from ${st.counterpartyName}`,
      });
    }
  }

  // Match SQL ORDER BY date ASC, kind ASC — 'session' < 'settlement'
  // lexicographically, so session events sort before settlement events on the
  // same date, matching the endpoint's behaviour.
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });

  return events;
}

// Running total → array of {date, total}. Rounded to 2 decimals to avoid
// accumulated float noise (the leaderboard numbers the chart end-value must
// match are already stored as REAL with 2 decimals of meaningful precision).
export function buildCumulative(events: HistoryEventRow[]): CumulativePoint[] {
  let running = 0;
  return events.map(e => {
    running += e.delta;
    return { date: e.date, total: Math.round(running * 100) / 100 };
  });
}

// Leaderboard-formula equivalent, computed from the same fixture inputs.
// This is the invariant the chart must preserve; exported so tests can
// assert cumulative[last].total === leaderboardTotal(...) without
// depending on Postgres.
export function leaderboardTotal(
  sessionResults: SessionResultRow[],
  settlements: SettlementRow[]
): number {
  const srSum = sessionResults.reduce((s, r) => s + r.amount, 0);
  const payerSum = settlements
    .filter(s => s.status === 'completed' && s.role === 'payer')
    .reduce((s, r) => s + r.amount, 0);
  const payeeSum = settlements
    .filter(s => s.status === 'completed' && s.role === 'payee')
    .reduce((s, r) => s + r.amount, 0);
  return Math.round((srSum + payerSum - payeeSum) * 100) / 100;
}
