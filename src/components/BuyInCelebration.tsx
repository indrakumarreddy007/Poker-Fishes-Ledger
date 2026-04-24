import React, { useEffect, useRef } from 'react';
import confetti from 'canvas-confetti';
import { getReloadMessage } from '../lib/buyInCelebration';

interface Props {
  /** Which buy-in number was just placed (1-indexed). Opening buy-in = 1 → no render. */
  buyInNumber: number;
  onDismiss: () => void;
  /** Auto-dismiss after this many ms. Tap to dismiss sooner. */
  autoDismissMs?: number;
}

/**
 * Full-screen celebratory overlay. Renders graffiti-style text + a confetti
 * burst when a player takes their 2nd or later buy-in. No-op for the
 * opening buy-in (buyInNumber < 2).
 *
 * Parent owns the lifecycle: mount when the trigger fires, listen for
 * onDismiss to unmount. The overlay auto-dismisses after autoDismissMs so
 * parents can just fire-and-forget.
 */
export default function BuyInCelebration({ buyInNumber, onDismiss, autoDismissMs = 2500 }: Props) {
  const message = getReloadMessage(buyInNumber);
  const confettiFired = useRef(false);

  useEffect(() => {
    if (!message) return;

    // Fire a burst once per mount. We don't re-fire on re-renders.
    if (!confettiFired.current) {
      confettiFired.current = true;
      // Two bursts from left + right for a wider spray.
      confetti({
        particleCount: 90,
        spread: 70,
        origin: { x: 0.2, y: 0.75 },
        colors: ['#34d399', '#fbbf24', '#fb7185', '#60a5fa', '#a78bfa'],
      });
      confetti({
        particleCount: 90,
        spread: 70,
        origin: { x: 0.8, y: 0.75 },
        colors: ['#34d399', '#fbbf24', '#fb7185', '#60a5fa', '#a78bfa'],
      });
    }

    const t = window.setTimeout(onDismiss, autoDismissMs);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [message, onDismiss, autoDismissMs]);

  if (!message) return null;

  const bgHue = message.hue;

  return (
    <div
      role="dialog"
      aria-label={`${message.title} — ${message.subtitle}`}
      aria-live="polite"
      onClick={onDismiss}
      className="fixed inset-0 z-[60] flex items-center justify-center px-6 animate-[fadeIn_220ms_ease-out] cursor-pointer"
      style={{
        background: `radial-gradient(circle at 50% 45%, hsla(${bgHue},85%,45%,0.35) 0%, rgba(0,0,0,0.55) 55%, rgba(0,0,0,0.75) 100%)`,
        backdropFilter: 'blur(4px)',
      }}
    >
      <div className="text-center select-none pointer-events-none">
        <div
          className="text-[22vw] md:text-[12rem] leading-none font-black tracking-tighter drop-shadow-2xl"
          style={{
            color: `hsl(${bgHue},95%,62%)`,
            transform: 'rotate(-4deg)',
            textShadow: `0 0 60px hsla(${bgHue},95%,55%,0.6), 0 6px 0 rgba(0,0,0,0.35)`,
            WebkitTextStroke: '2px rgba(0,0,0,0.25)',
          }}
        >
          {message.title}
        </div>
        <div className="mt-4 text-6xl md:text-8xl drop-shadow-xl" aria-hidden="true">
          {message.emoji}
        </div>
        <p
          className="mt-6 text-base md:text-lg font-bold text-white/90 tracking-wide max-w-md mx-auto drop-shadow"
        >
          {message.subtitle}
        </p>
        <p className="mt-3 text-[10px] font-black text-white/50 uppercase tracking-[0.3em]">
          Tap to dismiss
        </p>
      </div>

      {/* Keyframes inlined so we don't need to touch tailwind config. */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
