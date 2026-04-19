import { describe, it, expect } from 'vitest';
import {
  buildPlayerHistoryEvents,
  buildCumulative,
  leaderboardTotal,
  SessionResultRow,
  SettlementRow,
} from './playerHistory';

const sr = (date: string, amount: number, note = ''): SessionResultRow => ({ date, amount, note });
const settle = (
  date: string,
  amount: number,
  role: 'payer' | 'payee',
  counterpartyName: string,
  status = 'completed'
): SettlementRow => ({ date, amount, role, counterpartyName, status });

describe('buildPlayerHistoryEvents', () => {
  it('maps session_results verbatim with session note', () => {
    const events = buildPlayerHistoryEvents(
      [sr('2026-04-01', 500, 'Friday Night'), sr('2026-04-02', -200, 'Saturday')],
      []
    );
    expect(events).toEqual([
      { date: '2026-04-01', kind: 'session', delta: 500, note: 'Friday Night' },
      { date: '2026-04-02', kind: 'session', delta: -200, note: 'Saturday' },
    ]);
  });

  it('payer settlement keeps +amount (improves net) with "Settled with" note', () => {
    const events = buildPlayerHistoryEvents(
      [],
      [settle('2026-04-03', 300, 'payer', 'Bob')]
    );
    expect(events).toEqual([
      { date: '2026-04-03', kind: 'settlement', delta: 300, note: 'Settled with Bob' },
    ]);
  });

  it('payee settlement flips to -amount (realizes credit) with "Received from" note', () => {
    const events = buildPlayerHistoryEvents(
      [],
      [settle('2026-04-03', 300, 'payee', 'Alice')]
    );
    expect(events).toEqual([
      { date: '2026-04-03', kind: 'settlement', delta: -300, note: 'Received from Alice' },
    ]);
  });

  it('filters out non-completed settlements (pending, voided, etc.)', () => {
    const events = buildPlayerHistoryEvents(
      [],
      [
        settle('2026-04-03', 300, 'payer', 'Bob', 'pending'),
        settle('2026-04-04', 100, 'payee', 'Alice', 'voided'),
        settle('2026-04-05', 50, 'payer', 'Carol', 'completed'),
      ]
    );
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ note: 'Settled with Carol', delta: 50 });
  });

  it('sorts by date asc, then kind asc (session before settlement on same date)', () => {
    const events = buildPlayerHistoryEvents(
      [sr('2026-04-02', 100, 'Later'), sr('2026-04-01', 50, 'Earlier')],
      [settle('2026-04-02', 40, 'payer', 'Bob')]
    );
    expect(events.map(e => `${e.date}/${e.kind}`)).toEqual([
      '2026-04-01/session',
      '2026-04-02/session',
      '2026-04-02/settlement',
    ]);
  });
});

describe('buildCumulative', () => {
  it('produces running totals rounded to 2 decimals', () => {
    const cum = buildCumulative([
      { date: '2026-04-01', kind: 'session', delta: 100.555, note: '' },
      { date: '2026-04-02', kind: 'session', delta: -50.1, note: '' },
    ]);
    expect(cum).toEqual([
      { date: '2026-04-01', total: 100.56 },
      { date: '2026-04-02', total: 50.46 },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(buildCumulative([])).toEqual([]);
  });
});

describe('invariant: cumulative[last].total === leaderboardTotal()', () => {
  // This is THE test guarding the chart's math. If anyone flips a sign
  // in buildPlayerHistoryEvents without thinking, this breaks. The
  // leaderboardTotal function mirrors the SQL at api/index.ts:182-184.

  it('sessions only — simple sum', () => {
    const sessions = [sr('2026-04-01', 500, 's1'), sr('2026-04-02', -200, 's2')];
    const settlements: SettlementRow[] = [];
    const events = buildPlayerHistoryEvents(sessions, settlements);
    const cum = buildCumulative(events);
    expect(cum[cum.length - 1].total).toBe(leaderboardTotal(sessions, settlements));
    expect(cum[cum.length - 1].total).toBe(300);
  });

  it('mixed sessions + payer settlement (paying off a loss improves net)', () => {
    // Losses 1000; paid 400 → outstanding loss = 600 → chart should end at -600
    const sessions = [sr('2026-04-01', -1000, 'big loss')];
    const settlements = [settle('2026-04-02', 400, 'payer', 'Winner')];
    const events = buildPlayerHistoryEvents(sessions, settlements);
    const cum = buildCumulative(events);
    expect(cum[cum.length - 1].total).toBe(leaderboardTotal(sessions, settlements));
    expect(cum[cum.length - 1].total).toBe(-600);
  });

  it('mixed sessions + payee settlement (receiving reduces outstanding credit)', () => {
    // Wins 1000; received 400 → outstanding credit = 600 → chart should end at +600
    const sessions = [sr('2026-04-01', 1000, 'big win')];
    const settlements = [settle('2026-04-02', 400, 'payee', 'Loser')];
    const events = buildPlayerHistoryEvents(sessions, settlements);
    const cum = buildCumulative(events);
    expect(cum[cum.length - 1].total).toBe(leaderboardTotal(sessions, settlements));
    expect(cum[cum.length - 1].total).toBe(600);
  });

  it('fully-settled player ends at 0 on the chart', () => {
    const sessions = [sr('2026-04-01', -500, 'loss')];
    const settlements = [settle('2026-04-02', 500, 'payer', 'Winner')];
    const events = buildPlayerHistoryEvents(sessions, settlements);
    const cum = buildCumulative(events);
    expect(cum[cum.length - 1].total).toBe(0);
    expect(cum[cum.length - 1].total).toBe(leaderboardTotal(sessions, settlements));
  });

  it('voided settlements must NOT shift the chart end', () => {
    const sessions = [sr('2026-04-01', -500, 'loss')];
    const settlements = [
      settle('2026-04-02', 500, 'payer', 'Winner', 'voided'),
      settle('2026-04-03', 200, 'payer', 'Other', 'completed'),
    ];
    const events = buildPlayerHistoryEvents(sessions, settlements);
    const cum = buildCumulative(events);
    expect(cum[cum.length - 1].total).toBe(-300);
    expect(cum[cum.length - 1].total).toBe(leaderboardTotal(sessions, settlements));
  });

  it('complex history — multiple sessions + both payer and payee settlements', () => {
    const sessions = [
      sr('2026-04-01', 800, 's1'),
      sr('2026-04-02', -1200, 's2'),
      sr('2026-04-05', 300, 's3'),
    ];
    const settlements = [
      settle('2026-04-03', 500, 'payer', 'Bob'),      // +500
      settle('2026-04-04', 150, 'payee', 'Carol'),    // -150
      settle('2026-04-06', 99, 'payer', 'Dan', 'pending'), // ignored
    ];
    const events = buildPlayerHistoryEvents(sessions, settlements);
    const cum = buildCumulative(events);
    // 800 - 1200 + 500 - 150 + 300 = 250
    expect(cum[cum.length - 1].total).toBe(250);
    expect(cum[cum.length - 1].total).toBe(leaderboardTotal(sessions, settlements));
  });
});
