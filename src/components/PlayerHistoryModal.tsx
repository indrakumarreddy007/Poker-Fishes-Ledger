import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { computeScale, xFor, yFor } from '../lib/plChart';

interface HistoryEvent {
  date: string;
  kind: 'session' | 'settlement';
  delta: number;
  note: string;
}

interface CumulativePoint {
  date: string;
  total: number;
}

interface HistoryResponse {
  player: { id: number; name: string };
  events: HistoryEvent[];
  cumulative: CumulativePoint[];
}

interface Props {
  playerId: number;
  playerName: string;
  onClose: () => void;
}

const W = 300;
const H = 120;
const PAD_X = 8;
const PAD_Y = 10;

export default function PlayerHistoryModal({ playerId, playerName, onClose }: Props) {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/players/${playerId}/history`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (!cancelled) setError(body.error || `Failed (${res.status})`);
          return;
        }
        const json: HistoryResponse = await res.json();
        if (!cancelled) setData(json);
      } catch (e: any) {
        if (!cancelled) setError(`Network error: ${e.message}`);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  useEffect(() => {
    closeBtnRef.current?.focus();
    const prev = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);

  // Chart + headline number track SESSION P/L only. Settlements are cash
  // movements between players; they change Net Balance (what the /api/players
  // leaderboard shows) but not Net P/L at the table. Keeping them in the event
  // list below (so the user can still see when a debt was cleared) but off the
  // chart so the number next to "Net P/L Over Time" actually means that.
  const sessionEvents = (data?.events ?? []).filter((e) => e.kind === 'session');
  const sessionCumulative: CumulativePoint[] = [];
  {
    let running = 0;
    for (const e of sessionEvents) {
      running += e.delta;
      sessionCumulative.push({ date: e.date, total: Math.round(running * 100) / 100 });
    }
  }
  const scale = computeScale(
    sessionCumulative.map((p, i) => ({ sessionId: String(i), sessionName: p.date, date: i, pl: 0, cum: p.total }))
  );
  const lastTotal = sessionCumulative.length ? sessionCumulative[sessionCumulative.length - 1].total : 0;
  const positive = lastTotal >= 0;
  const stroke = positive ? '#34d399' : '#fb7185';
  const fill = positive ? 'rgba(16,185,129,0.15)' : 'rgba(244,63,94,0.15)';

  const points = sessionCumulative.map((p, i) => ({
    x: xFor(i, sessionCumulative.length, W, PAD_X),
    y: yFor(p.total, scale, H, PAD_Y),
  }));
  const polylinePoints = points.map((p) => `${p.x},${p.y}`).join(' ');
  const areaPath =
    points.length === 0
      ? ''
      : `M ${points[0].x},${yFor(0, scale, H, PAD_Y)} ` +
        points.map((p) => `L ${p.x},${p.y}`).join(' ') +
        ` L ${points[points.length - 1].x},${yFor(0, scale, H, PAD_Y)} Z`;
  const zeroY = yFor(0, scale, H, PAD_Y);

  // Highest single-session win / loss. Reduce to find extremes rather than
  // spreading into Math.max to stay safe against very large histories.
  let highestWin = 0;
  let highestLoss = 0;
  for (const e of sessionEvents) {
    if (e.delta > highestWin) highestWin = e.delta;
    if (e.delta < highestLoss) highestLoss = e.delta;
  }

  // Event list renders newest-first. Tie-break: settlement before session on
  // the same date (reverse of the server's asc ordering).
  const orderedEvents = [...(data?.events ?? [])].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.kind < b.kind ? 1 : a.kind > b.kind ? -1 : 0;
  });
  const hasAnyEvents = (data?.events.length ?? 0) > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`P/L history for ${playerName}`}
      onClick={onClose}
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-black/90 border border-white/10 rounded-3xl shadow-2xl w-full max-w-md p-6 space-y-5 max-h-[85vh] overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em]">
              Performance History
            </p>
            <h2 className="text-2xl font-black tracking-tighter text-white">{playerName}</h2>
          </div>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-400 hover:text-white transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <p className="text-rose-400 text-xs font-bold uppercase tracking-wider">{error}</p>
        )}

        {!error && !data && (
          <p className="text-zinc-500 text-sm font-medium">Loading history…</p>
        )}

        {data && !hasAnyEvents && (
          <p className="text-zinc-500 text-sm font-medium">No events yet for this player.</p>
        )}

        {data && hasAnyEvents && (
          <>
            {sessionEvents.length > 0 && (
              <div className="bg-white/5 rounded-2xl border border-white/10 p-3">
                <div className="flex items-center justify-between mb-2 px-1">
                  <span className="text-[9px] font-black text-zinc-500 uppercase tracking-[0.2em]">
                    Net P/L Over Time
                  </span>
                  <span
                    className={`text-sm font-black tabular-nums ${positive ? 'text-emerald-400' : 'text-rose-400'}`}
                  >
                    {positive ? '+' : '-'}₹{Math.abs(lastTotal).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28" preserveAspectRatio="none">
                  <line
                    x1={PAD_X}
                    y1={zeroY}
                    x2={W - PAD_X}
                    y2={zeroY}
                    stroke="rgba(255,255,255,0.15)"
                    strokeDasharray="3 3"
                    strokeWidth={1}
                  />
                  {areaPath && <path d={areaPath} fill={fill} />}
                  {points.length > 1 && (
                    <polyline points={polylinePoints} fill="none" stroke={stroke} strokeWidth={1.5} />
                  )}
                  {points.map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.y} r={2} fill={stroke} />
                  ))}
                </svg>
              </div>
            )}

            {sessionEvents.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-white/5 rounded-2xl border border-white/10 px-3 py-2.5">
                  <div className="text-[9px] font-black text-zinc-500 uppercase tracking-[0.2em]">
                    Highest Win
                  </div>
                  <div className="text-base font-black tabular-nums text-emerald-400">
                    {highestWin > 0
                      ? `+₹${highestWin.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                      : '—'}
                  </div>
                </div>
                <div className="bg-white/5 rounded-2xl border border-white/10 px-3 py-2.5">
                  <div className="text-[9px] font-black text-zinc-500 uppercase tracking-[0.2em]">
                    Highest Loss
                  </div>
                  <div className="text-base font-black tabular-nums text-rose-400">
                    {highestLoss < 0
                      ? `-₹${Math.abs(highestLoss).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                      : '—'}
                  </div>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-1.5">
              {orderedEvents.map((e, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/5"
                >
                  <div className="flex flex-col min-w-0">
                    <span className="text-xs font-bold text-zinc-300 truncate">{e.note || '—'}</span>
                    <span className="text-[10px] text-zinc-600 font-mono">{e.date} · {e.kind}</span>
                  </div>
                  <span
                    className={`text-sm font-black font-mono tabular-nums shrink-0 ${e.delta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}
                  >
                    {e.delta >= 0 ? '+' : '-'}₹{Math.abs(e.delta).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
