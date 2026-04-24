import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QUOTES, quoteAt, getSessionQuote } from './pokerQuotes';

describe('QUOTES', () => {
  it('every entry has non-empty text and author', () => {
    for (const q of QUOTES) {
      expect(q.text.trim().length).toBeGreaterThan(0);
      expect(q.author.trim().length).toBeGreaterThan(0);
    }
  });

  it('no duplicate quote texts', () => {
    const seen = new Set<string>();
    for (const q of QUOTES) {
      expect(seen.has(q.text)).toBe(false);
      seen.add(q.text);
    }
  });

  it('has enough quotes that rotation feels fresh', () => {
    // Below 10 and a user on a fast-reload loop sees repeats too often.
    expect(QUOTES.length).toBeGreaterThanOrEqual(10);
  });
});

describe('quoteAt', () => {
  it('returns the quote at the given index', () => {
    expect(quoteAt(0)).toBe(QUOTES[0]);
    expect(quoteAt(QUOTES.length - 1)).toBe(QUOTES[QUOTES.length - 1]);
  });

  it('wraps large positive indices via modulo', () => {
    expect(quoteAt(QUOTES.length)).toBe(QUOTES[0]);
    expect(quoteAt(QUOTES.length * 3 + 2)).toBe(QUOTES[2]);
  });

  it('wraps negative indices to a valid quote', () => {
    expect(quoteAt(-1)).toBe(QUOTES[QUOTES.length - 1]);
    expect(quoteAt(-QUOTES.length)).toBe(QUOTES[0]);
    expect(quoteAt(-QUOTES.length - 2)).toBe(QUOTES[QUOTES.length - 2]);
  });
});

describe('getSessionQuote', () => {
  // jsdom is not configured for this suite, so exercise the fallback path
  // by stubbing/unstubbing window.sessionStorage explicitly.
  const realWindow = (globalThis as any).window;

  afterEach(() => {
    (globalThis as any).window = realWindow;
    vi.restoreAllMocks();
  });

  it('falls back to a deterministic choice when storage is unavailable', () => {
    (globalThis as any).window = undefined;
    const q1 = getSessionQuote();
    const q2 = getSessionQuote();
    expect(QUOTES).toContain(q1);
    expect(q1).toBe(q2); // same hour → same fallback index
  });

  it('reads a previously-stored valid index from sessionStorage', () => {
    const store: Record<string, string> = { pokerQuoteIdx: '3' };
    (globalThis as any).window = {
      sessionStorage: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = v; },
      },
    };
    expect(getSessionQuote()).toBe(QUOTES[3]);
  });

  it('writes a new index when nothing is stored', () => {
    const store: Record<string, string> = {};
    (globalThis as any).window = {
      sessionStorage: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = v; },
      },
    };
    const picked = getSessionQuote();
    expect(QUOTES).toContain(picked);
    expect(store.pokerQuoteIdx).toBeDefined();
  });

  it('ignores an out-of-range stored index and picks fresh', () => {
    const store: Record<string, string> = { pokerQuoteIdx: String(QUOTES.length + 10) };
    (globalThis as any).window = {
      sessionStorage: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = v; },
      },
    };
    const picked = getSessionQuote();
    expect(QUOTES).toContain(picked);
    // A fresh index got written (may equal the original by chance — just
    // assert it's in range now).
    const newIdx = Number(store.pokerQuoteIdx);
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeLessThan(QUOTES.length);
  });

  it('ignores non-numeric stored values and picks fresh', () => {
    const store: Record<string, string> = { pokerQuoteIdx: 'not a number' };
    (globalThis as any).window = {
      sessionStorage: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = v; },
      },
    };
    const picked = getSessionQuote();
    expect(QUOTES).toContain(picked);
  });
});
