import { describe, it, expect } from 'vitest';
import {
  buildFishesPayload,
  PublishSessionInput,
  PublishPlayerInput,
  PublishBuyInInput,
} from './publishToLedger';

const session = (overrides: Partial<PublishSessionInput> = {}): PublishSessionInput => ({
  id: 'sess-1',
  name: 'Friday Night',
  status: 'closed',
  closedAt: '2026-04-18T19:30:00Z',
  publishedToLedger: false,
  publishedSessionId: null,
  ...overrides,
});

const player = (
  userId: string,
  name: string,
  finalWinnings: number | null
): PublishPlayerInput => ({ userId, name, finalWinnings });

const buyIn = (
  userId: string,
  amount: number,
  status: PublishBuyInInput['status'] = 'approved'
): PublishBuyInInput => ({ userId, amount, status });

describe('buildFishesPayload', () => {
  it('happy path: computes net per player and maps to Fishes shape', () => {
    const out = buildFishesPayload(
      session(),
      [player('a', 'Alice', 300), player('b', 'Bob', 50)],
      [buyIn('a', 100), buyIn('a', 50), buyIn('b', 100)]
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload.note).toBe('Friday Night');
    expect(out.payload.results).toEqual([
      { name: 'Alice', amount: 150 },
      { name: 'Bob', amount: -50 },
    ]);
  });

  it('uses closedAt converted to Asia/Kolkata for sessions.date', () => {
    // 2026-04-18T19:30:00Z + 5:30 = 2026-04-19 01:00 IST → date "2026-04-19"
    const out = buildFishesPayload(session({ closedAt: '2026-04-18T19:30:00Z' }), [], []);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload.date).toBe('2026-04-19');
  });

  it('rejects when already published and returns the prior Fishes session id', () => {
    const out = buildFishesPayload(
      session({ publishedToLedger: true, publishedSessionId: 42 }),
      [player('a', 'Alice', 100)],
      []
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toEqual({ code: 'already_published', fishesSessionId: 42 });
  });

  it('rejects when session is still active', () => {
    const out = buildFishesPayload(
      session({ status: 'active' }),
      [player('a', 'Alice', 100)],
      []
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('not_closed');
  });

  it('rejects when any buy-in is still pending', () => {
    const out = buildFishesPayload(
      session(),
      [player('a', 'Alice', 100)],
      [buyIn('a', 100, 'pending')]
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('pending_buyins');
  });

  it('rejects when a player has null final_winnings and names them', () => {
    const out = buildFishesPayload(
      session(),
      [player('a', 'Alice', 100), player('b', 'Bob', null)],
      []
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('missing_winnings');
    expect(out.error).toMatchObject({ message: expect.stringContaining('Bob') });
  });

  it('ignores rejected buy-ins in net calculation', () => {
    const out = buildFishesPayload(
      session(),
      [player('a', 'Alice', 100)],
      [buyIn('a', 100, 'approved'), buyIn('a', 500, 'rejected')]
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload.results[0].amount).toBe(0);
  });

  it('uses raw live_users.name verbatim — alias resolution happens server-side', () => {
    const out = buildFishesPayload(
      session(),
      [player('u1', 'mayanksingh', 500)],
      [buyIn('u1', 200)]
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload.results[0]).toEqual({ name: 'mayanksingh', amount: 300 });
  });

  it('handles players with zero winnings and zero buy-ins (net = 0)', () => {
    const out = buildFishesPayload(session(), [player('a', 'Alice', 0)], []);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload.results[0]).toEqual({ name: 'Alice', amount: 0 });
  });
});
