// Poker quotes for light flavor. Curated mix of named pros and anonymous
// table wisdom. Kept as a readonly array so the TS type narrows to the
// literal quotes — makes `author` autocomplete in editors and prevents
// accidental mutation.
//
// To add one: append to QUOTES. To remove one: delete its entry. That's it.

export interface PokerQuote {
  text: string;
  author: string;
}

export const QUOTES: readonly PokerQuote[] = [
  { text: "Poker is a combination of luck and skill. People think mastering the skill part is hard, but they're wrong. The trick to poker is mastering the luck.", author: 'Jesse May' },
  { text: "If you can't spot the sucker in your first half hour at the table, then you are the sucker.", author: 'Rounders' },
  { text: "Trust everyone, but always cut the cards.", author: 'Benny Binion' },
  { text: "Cards are war, in disguise of a sport.", author: 'Charles Lamb' },
  { text: "The guy who invented poker was bright, but the guy who invented the chip was a genius.", author: 'Julius Weintraub' },
  { text: "Poker is a lot like sex — everyone thinks they are the best, but most don't have a clue what they are doing.", author: 'Dutch Boyd' },
  { text: "A man with money is no match against a man on a mission.", author: "Doyle Brunson" },
  { text: "Aggressive play wins; passive play loses.", author: 'Doyle Brunson' },
  { text: "Limit poker is a science, but no-limit is an art.", author: 'Doyle Brunson' },
  { text: "You can shear a sheep many times, but you can skin it only once.", author: 'Amarillo Slim' },
  { text: "Don't play any hand, however strong, without thinking about the showdown.", author: 'Anonymous' },
  { text: "It's not whether you won or lost, but how many bad beat stories you had to sit through.", author: 'Anonymous' },
  { text: "Poker is 100% skill and 50% luck.", author: 'Phil Hellmuth' },
  { text: "If there weren't luck involved, I would win every time.", author: 'Phil Hellmuth' },
  { text: "The strongest force in the universe is a poker player's self-justification.", author: 'Anonymous' },
  { text: "Most of the money you'll win at poker comes not from the brilliance of your play, but from the ineptitude of your opponents.", author: 'Lou Krieger' },
  { text: "It takes a minute to learn and a lifetime to master.", author: 'Mike Sexton' },
  { text: "The beautiful thing about poker is that everybody thinks they can play.", author: "Chris Moneymaker" },
  { text: "You're never going to be a big winner if you play only when you feel like it.", author: 'Bobby Baldwin' },
  { text: "A good poker player thinks about what his opponent has. A great player thinks about what his opponent thinks he has.", author: 'Anonymous' },
  { text: "In the long run, there's no luck in poker — but the short run is longer than most people think.", author: "Rick Bennet" },
  { text: "The cards don't know you're a favourite.", author: 'Anonymous' },
  { text: "Don't let the fear of losing keep you from playing.", author: "Babe Ruth" },
  { text: "Life is a lot like poker. You have to play the hand you're dealt.", author: 'Anonymous' },
  { text: "Fold often, raise rarely, and never limp.", author: 'Home-game wisdom' },
] as const;

/**
 * Deterministic per-browser-session quote. Uses sessionStorage so a quote
 * stays stable during a visit (reads don't flicker) but rotates on the next
 * visit / tab reopen. Falls back to a time-based index when storage is
 * unavailable (SSR, private-mode Safari, tests without jsdom).
 */
export function getSessionQuote(): PokerQuote {
  const fallback = (): PokerQuote => {
    const i = Math.floor(Date.now() / 3_600_000) % QUOTES.length;
    return QUOTES[i];
  };
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return fallback();
    const stored = window.sessionStorage.getItem('pokerQuoteIdx');
    if (stored !== null) {
      const idx = Number(stored);
      if (Number.isInteger(idx) && idx >= 0 && idx < QUOTES.length) {
        return QUOTES[idx];
      }
    }
    const next = Math.floor(Math.random() * QUOTES.length);
    window.sessionStorage.setItem('pokerQuoteIdx', String(next));
    return QUOTES[next];
  } catch {
    return fallback();
  }
}

/** Pure picker for tests and callers that want an explicit index. */
export function quoteAt(index: number): PokerQuote {
  const i = ((index % QUOTES.length) + QUOTES.length) % QUOTES.length;
  return QUOTES[i];
}
