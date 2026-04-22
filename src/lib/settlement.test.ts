import { describe, it, expect } from 'vitest';
import { computePlayerResults, computeSettlements } from './settlement';

const player = (userId: string, name: string, finalWinnings?: number) => ({
  userId,
  name,
  finalWinnings,
});
const buyIn = (userId: string, amount: number) => ({ userId, amount });

describe('computePlayerResults', () => {
  it('sums multiple buy-ins per player and sorts by net desc', () => {
    const results = computePlayerResults(
      [player('a', 'Alice', 300), player('b', 'Bob', 50)],
      [buyIn('a', 100), buyIn('a', 50), buyIn('b', 100)]
    );
    expect(results[0]).toMatchObject({ name: 'Alice', buyIn: 150, winnings: 300, net: 150 });
    expect(results[1]).toMatchObject({ name: 'Bob', buyIn: 100, winnings: 50, net: -50 });
  });

  it('treats missing finalWinnings as 0', () => {
    const results = computePlayerResults([player('a', 'Alice')], [buyIn('a', 100)]);
    expect(results[0].winnings).toBe(0);
    expect(results[0].net).toBe(-100);
  });

  it('ignores buy-ins from players not in the list (net stays zero for no-buy-in players)', () => {
    const results = computePlayerResults(
      [player('a', 'Alice', 100)],
      [buyIn('ghost', 500), buyIn('a', 50)]
    );
    expect(results[0].buyIn).toBe(50);
    expect(results[0].net).toBe(50);
  });

  it('returns empty when there are no players', () => {
    expect(computePlayerResults([], [buyIn('a', 100)])).toEqual([]);
  });

  it('returns players with zero buy-in and zero net when there are no buy-ins', () => {
    const results = computePlayerResults([player('a', 'Alice', 0)], []);
    expect(results[0]).toMatchObject({ buyIn: 0, winnings: 0, net: 0 });
  });
});

describe('computeSettlements', () => {
  it('produces zero transactions when everyone breaks even', () => {
    const txs = computeSettlements([
      { userId: 'a', name: 'A', buyIn: 100, winnings: 100, net: 0 },
      { userId: 'b', name: 'B', buyIn: 100, winnings: 100, net: 0 },
    ]);
    expect(txs).toEqual([]);
  });

  it('pairs a single loser to a single winner', () => {
    const txs = computeSettlements([
      { userId: 'w', name: 'Winner', buyIn: 0, winnings: 100, net: 100 },
      { userId: 'l', name: 'Loser', buyIn: 100, winnings: 0, net: -100 },
    ]);
    expect(txs).toEqual([{ from: 'Loser', to: 'Winner', amount: 100 }]);
  });

  it('splits a big loss across two winners greedily', () => {
    const txs = computeSettlements([
      { userId: 'w1', name: 'W1', buyIn: 0, winnings: 60, net: 60 },
      { userId: 'w2', name: 'W2', buyIn: 0, winnings: 40, net: 40 },
      { userId: 'l', name: 'L', buyIn: 100, winnings: 0, net: -100 },
    ]);
    expect(txs).toEqual([
      { from: 'L', to: 'W1', amount: 60 },
      { from: 'L', to: 'W2', amount: 40 },
    ]);
  });

  it('splits one winner across two losers', () => {
    const txs = computeSettlements([
      { userId: 'w', name: 'W', buyIn: 0, winnings: 100, net: 100 },
      { userId: 'l1', name: 'L1', buyIn: 60, winnings: 0, net: -60 },
      { userId: 'l2', name: 'L2', buyIn: 40, winnings: 0, net: -40 },
    ]);
    expect(txs).toHaveLength(2);
    expect(txs).toEqual(
      expect.arrayContaining([
        { from: 'L1', to: 'W', amount: 60 },
        { from: 'L2', to: 'W', amount: 40 },
      ])
    );
  });

  it('rounds payment amounts to 2 decimals', () => {
    const txs = computeSettlements([
      { userId: 'w', name: 'W', buyIn: 0, winnings: 33.333, net: 33.333 },
      { userId: 'l', name: 'L', buyIn: 33.333, winnings: 0, net: -33.333 },
    ]);
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(33.33);
  });

  it('handles floating-point residues under the 0.01 threshold without looping forever', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in JS — residue must not trap the loop.
    const txs = computeSettlements([
      { userId: 'w', name: 'W', buyIn: 0, winnings: 0.3, net: 0.1 + 0.2 },
      { userId: 'l', name: 'L', buyIn: 0.3, winnings: 0, net: -(0.1 + 0.2) },
    ]);
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBeCloseTo(0.3, 2);
  });

  it('returns empty when there are only winners (no one to pay)', () => {
    const txs = computeSettlements([
      { userId: 'w', name: 'W', buyIn: 0, winnings: 100, net: 100 },
    ]);
    expect(txs).toEqual([]);
  });

  it('returns empty when there are only losers (no one to receive)', () => {
    const txs = computeSettlements([
      { userId: 'l', name: 'L', buyIn: 100, winnings: 0, net: -100 },
    ]);
    expect(txs).toEqual([]);
  });

  it('returns empty for empty input', () => {
    expect(computeSettlements([])).toEqual([]);
  });

  it('total payments equal total losses', () => {
    const results = [
      { userId: 'w1', name: 'W1', buyIn: 100, winnings: 250, net: 150 },
      { userId: 'w2', name: 'W2', buyIn: 100, winnings: 150, net: 50 },
      { userId: 'l1', name: 'L1', buyIn: 100, winnings: 0, net: -100 },
      { userId: 'l2', name: 'L2', buyIn: 100, winnings: 0, net: -100 },
    ];
    const txs = computeSettlements(results);
    const total = txs.reduce((s, t) => s + t.amount, 0);
    expect(total).toBeCloseTo(200, 2);
  });
});
