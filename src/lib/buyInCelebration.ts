// Pure message picker for the Live buy-in celebration overlay.
//
// The overlay fires when a player submits their 2nd-or-later buy-in in a
// single Live session. Messages escalate with reload count so a 2nd buy-in
// feels playful and a 6th+ raises an affectionate eyebrow.
//
// Keep this pure (no React, no DOM) so it's unit-testable and so the
// caller can decide when to render.

export interface CelebrationMessage {
  /** Short all-caps headline. Rendered in graffiti style. */
  title: string;
  /** One-line follow-up below the title. Sentence case. */
  subtitle: string;
  /** Single emoji paired with the headline. */
  emoji: string;
  /** HSL hue for the overlay accent; escalates toward warm tones. */
  hue: number;
}

/**
 * Messages keyed by buy-in number (the one just placed). Anything below 2
 * returns null — no celebration for the opening buy-in.
 */
export function getReloadMessage(buyInNumber: number): CelebrationMessage | null {
  if (!Number.isFinite(buyInNumber) || buyInNumber < 2) return null;

  if (buyInNumber === 2) {
    return { title: 'RELOAD',      subtitle: "One more won't hurt.",               emoji: '🔥', hue: 145 };
  }
  if (buyInNumber === 3) {
    return { title: 'TRIPLE DOWN', subtitle: 'Committed. No turning back now.',    emoji: '💪', hue: 45  };
  }
  if (buyInNumber === 4) {
    return { title: 'THE GRIND',   subtitle: "Respect — you're in it now.",        emoji: '🎰', hue: 25  };
  }
  if (buyInNumber === 5) {
    return { title: 'LEGEND MODE', subtitle: 'Or is this chasing? Asking for a friend.', emoji: '🏆', hue: 15 };
  }
  // 6th and beyond
  return {
    title: 'STILL HERE?',
    subtitle: 'Maybe call it a night. Or double again — we do not judge.',
    emoji: '😅',
    hue: 0,
  };
}

/**
 * Counts how many non-rejected buy-ins a user has SO FAR — i.e. BEFORE
 * the new one they're about to submit. Caller adds 1 to get the buy-in
 * number they're placing now. Pulled out as a pure helper so the trigger
 * logic is testable without mocking a component.
 */
export function countPriorBuyIns(
  buyIns: readonly { status: string; userId?: string }[],
  userId?: string
): number {
  return buyIns.filter((b) => {
    if (userId && b.userId && b.userId !== userId) return false;
    return b.status !== 'rejected';
  }).length;
}
