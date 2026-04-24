import { describe, it, expect } from 'vitest';
import { getReloadMessage, countPriorBuyIns } from './buyInCelebration';

describe('getReloadMessage', () => {
  it('returns null for 1st buy-in (the opening is not a celebration)', () => {
    expect(getReloadMessage(1)).toBeNull();
  });

  it('returns null for 0 and negative counts', () => {
    expect(getReloadMessage(0)).toBeNull();
    expect(getReloadMessage(-1)).toBeNull();
  });

  it('returns null for non-finite input', () => {
    expect(getReloadMessage(NaN)).toBeNull();
    expect(getReloadMessage(Infinity)).toBeNull();
  });

  it('RELOAD on 2nd', () => {
    const m = getReloadMessage(2)!;
    expect(m.title).toBe('RELOAD');
    expect(m.emoji).toBe('🔥');
  });

  it('TRIPLE DOWN on 3rd', () => {
    expect(getReloadMessage(3)!.title).toBe('TRIPLE DOWN');
  });

  it('THE GRIND on 4th', () => {
    expect(getReloadMessage(4)!.title).toBe('THE GRIND');
  });

  it('LEGEND MODE on 5th', () => {
    expect(getReloadMessage(5)!.title).toBe('LEGEND MODE');
  });

  it('STILL HERE? on 6th and beyond', () => {
    expect(getReloadMessage(6)!.title).toBe('STILL HERE?');
    expect(getReloadMessage(7)!.title).toBe('STILL HERE?');
    expect(getReloadMessage(42)!.title).toBe('STILL HERE?');
  });

  it('every returned message has non-empty fields', () => {
    for (const n of [2, 3, 4, 5, 6, 10]) {
      const m = getReloadMessage(n)!;
      expect(m.title.length).toBeGreaterThan(0);
      expect(m.subtitle.length).toBeGreaterThan(0);
      expect(m.emoji.length).toBeGreaterThan(0);
      expect(m.hue).toBeGreaterThanOrEqual(0);
      expect(m.hue).toBeLessThanOrEqual(360);
    }
  });
});

describe('countPriorBuyIns', () => {
  const bi = (status: string, userId = 'u1') => ({ status, userId });

  it('counts pending + approved, excludes rejected', () => {
    const n = countPriorBuyIns([bi('approved'), bi('pending'), bi('rejected')]);
    expect(n).toBe(2);
  });

  it('returns 0 for empty list', () => {
    expect(countPriorBuyIns([])).toBe(0);
  });

  it('filters by userId when provided', () => {
    const n = countPriorBuyIns(
      [bi('approved', 'u1'), bi('approved', 'u2'), bi('pending', 'u1')],
      'u1'
    );
    expect(n).toBe(2);
  });

  it('without userId filter, counts across all users', () => {
    const n = countPriorBuyIns([bi('approved', 'u1'), bi('approved', 'u2')]);
    expect(n).toBe(2);
  });

  it('handles entries missing userId gracefully when filter is set', () => {
    // Entries without userId pass through — we only reject on mismatch, not
    // on absence. This protects against schemas that drop the field.
    const n = countPriorBuyIns(
      [{ status: 'approved' }, { status: 'rejected' }],
      'u1'
    );
    expect(n).toBe(1);
  });
});
