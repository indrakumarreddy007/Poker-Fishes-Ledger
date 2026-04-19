import { describe, it, expect } from 'vitest';
import { computeCumulative, computeScale, xFor, yFor, type SessionPLPoint } from './plChart';

const pt = (id: string, pl: number, date = 0): SessionPLPoint => ({
  sessionId: id,
  sessionName: id,
  date,
  pl,
});

describe('computeCumulative', () => {
  it('accumulates running total', () => {
    const cum = computeCumulative([pt('a', 100), pt('b', -40), pt('c', 20)]);
    expect(cum.map(c => c.cum)).toEqual([100, 60, 80]);
  });

  it('returns empty for empty input', () => {
    expect(computeCumulative([])).toEqual([]);
  });

  it('preserves per-point pl alongside cum', () => {
    const cum = computeCumulative([pt('a', 50), pt('b', -10)]);
    expect(cum[1]).toMatchObject({ sessionId: 'b', pl: -10, cum: 40 });
  });
});

describe('computeScale', () => {
  it('clamps minV at most 0 and maxV at least 0 for all-positive series', () => {
    const scale = computeScale(computeCumulative([pt('a', 50), pt('b', 30)]));
    expect(scale.minV).toBe(0);
    expect(scale.maxV).toBe(80);
    expect(scale.span).toBe(80);
  });

  it('clamps maxV at 0 for all-negative series', () => {
    const scale = computeScale(computeCumulative([pt('a', -20), pt('b', -30)]));
    expect(scale.minV).toBe(-50);
    expect(scale.maxV).toBe(0);
    expect(scale.span).toBe(50);
  });

  it('straddles zero when series crosses it', () => {
    const scale = computeScale(computeCumulative([pt('a', 40), pt('b', -90)]));
    expect(scale.minV).toBe(-50);
    expect(scale.maxV).toBe(40);
    expect(scale.span).toBe(90);
  });

  it('returns span of 1 (not 0) when all values are zero — avoids divide-by-zero', () => {
    const scale = computeScale(computeCumulative([pt('a', 0), pt('b', 0)]));
    expect(scale.span).toBe(1);
  });
});

describe('xFor', () => {
  it('centers a single point horizontally', () => {
    expect(xFor(0, 1, 320, 8)).toBe(160);
  });

  it('maps first point to left-pad and last to right-pad for N > 1', () => {
    const W = 320;
    const padX = 8;
    expect(xFor(0, 5, W, padX)).toBe(padX);
    expect(xFor(4, 5, W, padX)).toBe(W - padX);
  });

  it('distributes evenly for N=3', () => {
    expect(xFor(0, 3, 320, 8)).toBe(8);
    expect(xFor(1, 3, 320, 8)).toBe(160);
    expect(xFor(2, 3, 320, 8)).toBe(312);
  });
});

describe('yFor', () => {
  const scale = { minV: -50, maxV: 50, span: 100 };

  it('maps maxV to top (padY)', () => {
    expect(yFor(50, scale, 140, 12)).toBe(12);
  });

  it('maps minV to bottom (H - padY)', () => {
    expect(yFor(-50, scale, 140, 12)).toBe(128);
  });

  it('maps 0 to vertical midpoint', () => {
    expect(yFor(0, scale, 140, 12)).toBe(70);
  });
});
