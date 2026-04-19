import { describe, it, expect } from 'vitest';
import { aggregateTableBuyIns, potShare, tablePot } from './buyIns';

type BuyInStatus = 'pending' | 'approved' | 'rejected';

const buyIn = (userId: string, amount: number, status: BuyInStatus = 'approved') => ({
  userId,
  amount,
  status,
});
const player = (userId: string, name: string) => ({ userId, name });

describe('aggregateTableBuyIns', () => {
  it('sums multiple approved buy-ins per player', () => {
    const rows = aggregateTableBuyIns(
      [buyIn('a', 100), buyIn('a', 50), buyIn('b', 200)],
      [player('a', 'Alice'), player('b', 'Bob')],
      'a'
    );
    expect(rows).toHaveLength(2);
    const alice = rows.find(r => r.userId === 'a')!;
    expect(alice.total).toBe(150);
  });

  it('filters out pending and rejected buy-ins', () => {
    const rows = aggregateTableBuyIns(
      [
        buyIn('a', 100, 'approved'),
        buyIn('a', 999, 'pending'),
        buyIn('a', 500, 'rejected'),
      ],
      [player('a', 'Alice')],
      'a'
    );
    expect(rows[0].total).toBe(100);
  });

  it('sorts by total descending', () => {
    const rows = aggregateTableBuyIns(
      [buyIn('a', 50), buyIn('b', 200), buyIn('c', 100)],
      [player('a', 'Alice'), player('b', 'Bob'), player('c', 'Carol')],
      'a'
    );
    expect(rows.map(r => r.name)).toEqual(['Bob', 'Carol', 'Alice']);
  });

  it('marks the current user as isSelf', () => {
    const rows = aggregateTableBuyIns(
      [buyIn('a', 50), buyIn('b', 100)],
      [player('a', 'Alice'), player('b', 'Bob')],
      'b'
    );
    expect(rows.find(r => r.userId === 'b')!.isSelf).toBe(true);
    expect(rows.find(r => r.userId === 'a')!.isSelf).toBe(false);
  });

  it('falls back to "Player" when user is not in the players list', () => {
    const rows = aggregateTableBuyIns([buyIn('ghost', 50)], [], 'me');
    expect(rows[0].name).toBe('Player');
  });

  it('returns empty when there are no approved buy-ins', () => {
    const rows = aggregateTableBuyIns(
      [buyIn('a', 100, 'pending')],
      [player('a', 'Alice')],
      'a'
    );
    expect(rows).toEqual([]);
  });
});

describe('potShare', () => {
  it('returns the percentage of pot', () => {
    expect(potShare(25, 100)).toBe(25);
    expect(potShare(50, 200)).toBe(25);
  });

  it('returns 0 when pot is zero (avoid divide-by-zero)', () => {
    expect(potShare(100, 0)).toBe(0);
  });

  it('returns 0 when pot is negative', () => {
    expect(potShare(100, -50)).toBe(0);
  });
});

describe('tablePot', () => {
  it('sums row totals', () => {
    expect(tablePot([{ total: 100 }, { total: 50 }, { total: 25 }])).toBe(175);
  });

  it('returns 0 for empty input', () => {
    expect(tablePot([])).toBe(0);
  });
});
