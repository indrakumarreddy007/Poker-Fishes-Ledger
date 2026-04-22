import { describe, it, expect } from 'vitest';
import { deriveModalView, type HistoryEvent } from './playerHistoryView';

// Factories mirror the shape returned by /api/players/:id/history.
const session = (date: string, delta: number, note = ''): HistoryEvent => ({
  date,
  kind: 'session',
  delta,
  note,
});
const settlement = (date: string, delta: number, note = ''): HistoryEvent => ({
  date,
  kind: 'settlement',
  delta,
  note,
});

describe('deriveModalView — sessionCumulative', () => {
  it('running sum ends at sum of session deltas', () => {
    const v = deriveModalView([
      session('2026-04-01', 500),
      session('2026-04-02', -200),
      session('2026-04-05', 100),
    ]);
    expect(v.sessionCumulative.map(p => p.total)).toEqual([500, 300, 400]);
  });

  it('excludes settlements entirely from running total', () => {
    // If the +1000 settlement leaked in, the ending total would be 1300.
    const v = deriveModalView([
      session('2026-04-01', 500),
      settlement('2026-04-02', 1000, 'Received'),
      session('2026-04-03', -200),
    ]);
    expect(v.sessionCumulative).toEqual([
      { date: '2026-04-01', total: 500 },
      { date: '2026-04-03', total: 300 },
    ]);
  });

  it('rounds running total to 2 decimals at each step', () => {
    // 100.555 * 100 = 10055.5 in IEEE 754, which Math.round takes up to
    // 10056 → 100.56. Then the running float is 50.45500000000001 → 50.46.
    // These literal values come straight from the task spec.
    const v = deriveModalView([
      session('2026-04-01', 100.555),
      session('2026-04-02', -50.1),
    ]);
    expect(v.sessionCumulative[0].total).toBe(100.56);
    expect(v.sessionCumulative[1].total).toBe(50.46);
  });

  it('is empty when there are zero sessions even if settlements present', () => {
    const v = deriveModalView([
      settlement('2026-04-01', 100, 'Paid'),
      settlement('2026-04-02', -50, 'Received'),
    ]);
    expect(v.sessionCumulative).toEqual([]);
  });

  it('is empty for empty input', () => {
    expect(deriveModalView([]).sessionCumulative).toEqual([]);
  });
});

describe('deriveModalView — highestWin / highestLoss', () => {
  it('mixed wins and losses — picks each extreme', () => {
    const v = deriveModalView([
      session('2026-04-01', 500),
      session('2026-04-02', -200),
      session('2026-04-03', 750),   // largest win
      session('2026-04-04', -900),  // largest loss
      session('2026-04-05', 50),
    ]);
    expect(v.highestWin).toBe(750);
    expect(v.highestLoss).toBe(-900);
  });

  it('only wins → highestLoss is 0 (not -Infinity)', () => {
    const v = deriveModalView([
      session('2026-04-01', 100),
      session('2026-04-02', 200),
    ]);
    expect(v.highestWin).toBe(200);
    expect(v.highestLoss).toBe(0);
  });

  it('only losses → highestWin is 0 (not -Infinity)', () => {
    const v = deriveModalView([
      session('2026-04-01', -100),
      session('2026-04-02', -300),
    ]);
    expect(v.highestWin).toBe(0);
    expect(v.highestLoss).toBe(-300);
  });

  it('zero sessions → both are 0', () => {
    const v = deriveModalView([]);
    expect(v.highestWin).toBe(0);
    expect(v.highestLoss).toBe(0);
  });

  it('zero sessions but settlements present → still both 0', () => {
    const v = deriveModalView([
      settlement('2026-04-01', 5000, 'Big payout'),
      settlement('2026-04-02', -10000, 'Big payment'),
    ]);
    expect(v.highestWin).toBe(0);
    expect(v.highestLoss).toBe(0);
  });

  it('single winning session → highestWin = delta, highestLoss = 0', () => {
    const v = deriveModalView([session('2026-04-01', 420)]);
    expect(v.highestWin).toBe(420);
    expect(v.highestLoss).toBe(0);
  });

  it('settlements with extreme deltas DO NOT influence win/loss', () => {
    // If settlements leaked in, highestWin would be 9_999_999 and
    // highestLoss would be -9_999_999. Any of those fails the assertion.
    const v = deriveModalView([
      session('2026-04-01', 100),
      settlement('2026-04-02', 9_999_999, 'Giant payout'),
      session('2026-04-03', -50),
      settlement('2026-04-04', -9_999_999, 'Giant payment'),
    ]);
    expect(v.highestWin).toBe(100);
    expect(v.highestLoss).toBe(-50);
  });

  it('exactly-zero session delta counts as neither win nor loss', () => {
    // A 0 delta is neither > 0 nor < 0, so both extremes stay at their
    // initial 0. This guards the boundary comparison.
    const v = deriveModalView([session('2026-04-01', 0)]);
    expect(v.highestWin).toBe(0);
    expect(v.highestLoss).toBe(0);
  });
});

describe('deriveModalView — orderedEvents', () => {
  it('orders newest-first by date DESC', () => {
    const v = deriveModalView([
      session('2026-04-01', 10),
      session('2026-04-05', 50),
      session('2026-04-03', 20),
    ]);
    expect(v.orderedEvents.map(e => e.date)).toEqual([
      '2026-04-05',
      '2026-04-03',
      '2026-04-01',
    ]);
  });

  it('is stable when two events share the same date (keeps input order)', () => {
    // Since sessionEvents is a filtered slice of input in original order,
    // two same-date sessions should come out in the same relative order.
    const v = deriveModalView([
      session('2026-04-02', 100, 'first-of-day'),
      session('2026-04-02', 200, 'second-of-day'),
      session('2026-04-01', 50, 'earlier'),
    ]);
    // Date-desc ordering, and within 2026-04-02 the original order
    // (first-of-day → second-of-day) is preserved.
    expect(v.orderedEvents.map(e => e.note)).toEqual([
      'first-of-day',
      'second-of-day',
      'earlier',
    ]);
  });

  it('excludes all settlements from the list', () => {
    const v = deriveModalView([
      session('2026-04-01', 100),
      settlement('2026-04-02', 50, 'Paid'),
      session('2026-04-03', -40),
      settlement('2026-04-04', -30, 'Received'),
    ]);
    expect(v.orderedEvents.every(e => e.kind === 'session')).toBe(true);
    expect(v.orderedEvents).toHaveLength(2);
  });

  it('is empty for empty input', () => {
    expect(deriveModalView([]).orderedEvents).toEqual([]);
  });

  it('is empty when only settlements are present', () => {
    const v = deriveModalView([
      settlement('2026-04-01', 100, 'Paid'),
      settlement('2026-04-02', -50, 'Received'),
    ]);
    expect(v.orderedEvents).toEqual([]);
  });
});

describe('deriveModalView — sessionEvents passthrough', () => {
  it('returns filtered sessions in endpoint-provided order (pre-sort)', () => {
    // sessionEvents preserves the input order of session events (unlike
    // orderedEvents which reverses by date). This is what downstream
    // chart/cumulative code iterates over.
    const v = deriveModalView([
      session('2026-04-01', 10, 'a'),
      settlement('2026-04-01', 5, 'skip'),
      session('2026-04-02', 20, 'b'),
      session('2026-04-03', -5, 'c'),
    ]);
    expect(v.sessionEvents.map(e => e.note)).toEqual(['a', 'b', 'c']);
  });
});
