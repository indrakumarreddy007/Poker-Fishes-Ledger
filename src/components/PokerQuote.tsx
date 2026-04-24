import React, { useMemo } from 'react';
import { Quote as QuoteIcon } from 'lucide-react';
import { getSessionQuote, type PokerQuote } from '../lib/pokerQuotes';

interface Props {
  /** Optional override — useful for testing and for rendering a specific quote. */
  quote?: PokerQuote;
  /** 'strip' = compact slim bar; 'card' = featured block for landing pages. */
  variant?: 'strip' | 'card';
  className?: string;
}

export default function PokerQuote({ quote, variant = 'strip', className }: Props) {
  const q = useMemo(() => quote ?? getSessionQuote(), [quote]);

  if (variant === 'card') {
    return (
      <section
        aria-label="Poker quote"
        className={`glass rounded-3xl border border-white/10 p-6 shadow-2xl ${className ?? ''}`}
      >
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
            <QuoteIcon size={18} className="text-amber-400" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-black text-amber-400/80 uppercase tracking-[0.25em]">
              Table Wisdom
            </p>
            <blockquote className="mt-2 text-sm font-bold text-zinc-100 leading-relaxed">
              {q.text}
            </blockquote>
            <p className="mt-3 text-[11px] font-black text-zinc-500 uppercase tracking-widest">
              — {q.author}
            </p>
          </div>
        </div>
      </section>
    );
  }

  // strip
  return (
    <div
      aria-label="Poker quote"
      className={`flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-white/[0.03] border border-white/5 ${className ?? ''}`}
    >
      <QuoteIcon size={14} className="text-amber-400/70 shrink-0" />
      <p className="text-[11px] font-bold text-zinc-400 italic leading-snug truncate">
        <span className="text-zinc-300">{q.text}</span>
        <span className="ml-2 text-zinc-600 not-italic font-black tracking-wider text-[9px] uppercase">
          — {q.author}
        </span>
      </p>
    </div>
  );
}
