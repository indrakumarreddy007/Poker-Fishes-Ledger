// Pure view-model derivations for PlayerHistoryModal.
//
// The modal shows session P/L only — the cumulative chart line, the
// Highest Win / Highest Loss tiles, and the newest-first event list all
// come from here. Settlements are present in the endpoint response so
// other callers can reconstruct the Net-Balance series (see
// api/lib/playerHistory.ts), but the modal filters them out entirely.
//
// Keep this file pure so it can be unit-tested without a DOM. The modal
// just calls `deriveModalView(data.events)` and renders the result.

export interface HistoryEvent {
  date: string;
  kind: 'session' | 'settlement';
  delta: number;
  note: string;
}

export interface CumulativePoint {
  date: string;
  total: number;
}

export interface ModalView {
  sessionEvents: HistoryEvent[];
  sessionCumulative: CumulativePoint[];
  highestWin: number;
  highestLoss: number;
  orderedEvents: HistoryEvent[];
}

export function deriveModalView(events: HistoryEvent[]): ModalView {
  const sessionEvents = events.filter(e => e.kind === 'session');

  // Running total, rounded to 2 decimals to avoid accumulated float noise.
  const sessionCumulative: CumulativePoint[] = [];
  let running = 0;
  for (const e of sessionEvents) {
    running += e.delta;
    sessionCumulative.push({ date: e.date, total: Math.round(running * 100) / 100 });
  }

  // Highest single-session win / loss. Default to 0 (not -Infinity) so the
  // UI can render a clean "—" dash when there are no positives / negatives.
  let highestWin = 0;
  let highestLoss = 0;
  for (const e of sessionEvents) {
    if (e.delta > highestWin) highestWin = e.delta;
    if (e.delta < highestLoss) highestLoss = e.delta;
  }

  // Newest-first list. Stable across equal dates (Array.prototype.sort is
  // stable per spec since ES2019) — callers of buildPlayerHistoryEvents get
  // date-asc input, so equal dates stay in their endpoint-provided order
  // after this reverse-on-date sort.
  const orderedEvents = [...sessionEvents].sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? 1 : -1) : 0
  );

  return { sessionEvents, sessionCumulative, highestWin, highestLoss, orderedEvents };
}
