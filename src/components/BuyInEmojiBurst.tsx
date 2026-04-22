import React, { useEffect, useMemo } from 'react';

// Tiered reaction to a buy-in. `isFirst` trumps amount (a player's first
// buy-in always feels celebratory regardless of size). Otherwise the tier
// scales with the house minimum: a ₹1000-1500 top-up is a steady chip-up,
// ₹1500-3000 is a solid stack, and anything over 3× the minimum flips the
// vibe sad — a gentle nudge that big late-game top-ups usually mean losses.
// Overlay is pointer-events-none so the burst never blocks the form beneath.
const MIN_BUYIN = 1000;
const NEAR_MIN_CEIL = Math.round(MIN_BUYIN * 1.5); // 1500
const HIGH_STAKES_THRESHOLD = MIN_BUYIN * 3;       // 3000

interface Props {
  amount: number;
  isFirst: boolean;
  onDone: () => void;
}

type Tier = 'welcome' | 'steady' | 'solid' | 'highStakes';

function tierFor(amount: number, isFirst: boolean): Tier {
  if (isFirst) return 'welcome';
  if (amount > HIGH_STAKES_THRESHOLD) return 'highStakes';
  if (amount <= NEAR_MIN_CEIL) return 'steady';
  return 'solid';
}

const TIERS: Record<
  Tier,
  {
    emojis: string[];
    message: string;
    subMessage: string;
    tint: string;
    glow: string;
  }
> = {
  welcome: {
    emojis: ['🎉', '🥳', '🎊', '🍾', '✨', '🎆', '💸', '🏆'],
    message: 'Welcome to the table!',
    subMessage: 'First buy-in — good luck!',
    tint: 'text-emerald-400',
    glow: 'shadow-emerald-500/30',
  },
  steady: {
    emojis: ['👌', '🙂', '🪙', '♠️', '♣️'],
    message: 'Steady chip-up',
    subMessage: 'Playing it smart.',
    tint: 'text-teal-400',
    glow: 'shadow-teal-500/30',
  },
  solid: {
    emojis: ['🔥', '💰', '👍', '🎯', '♥️', '♦️'],
    message: 'Solid stack',
    subMessage: 'Locked in — run it up.',
    tint: 'text-sky-400',
    glow: 'shadow-sky-500/30',
  },
  highStakes: {
    emojis: ['😢', '💸', '😭', '😬', '💔', '🫠'],
    message: `Another ₹${HIGH_STAKES_THRESHOLD}+ top-up?`,
    subMessage: 'The fish pond is getting deep…',
    tint: 'text-rose-400',
    glow: 'shadow-rose-500/30',
  },
};

interface Particle {
  id: number;
  emoji: string;
  left: number;
  delay: number;
  duration: number;
  drift: number;
  rotate: number;
  size: number;
}

function buildParticles(emojis: string[], tier: Tier): Particle[] {
  const count =
    tier === 'welcome' ? 32 :
    tier === 'highStakes' ? 18 :
    tier === 'solid' ? 22 :
    14; // steady — deliberately lightest, a quiet thumbs-up
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    emoji: emojis[i % emojis.length],
    left: Math.random() * 100,
    delay: Math.random() * 400,
    duration: 1400 + Math.random() * 1000,
    drift: (Math.random() - 0.5) * 160,
    rotate: (Math.random() - 0.5) * 540,
    size: 22 + Math.random() * 26,
  }));
}

export default function BuyInEmojiBurst({ amount, isFirst, onDone }: Props) {
  const tier = tierFor(amount, isFirst);
  const cfg = TIERS[tier];
  const particles = useMemo(() => buildParticles(cfg.emojis, tier), [cfg.emojis, tier]);

  useEffect(() => {
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div
      className="fixed inset-0 z-[100] pointer-events-none overflow-hidden"
      aria-live="polite"
      aria-label={cfg.message}
    >
      {tier === 'welcome' && (
        <div className="absolute inset-0 bg-gradient-radial from-emerald-500/10 via-transparent to-transparent animate-fade-quick" />
      )}
      {tier === 'highStakes' && (
        <div className="absolute inset-0 bg-gradient-radial from-rose-500/10 via-transparent to-transparent animate-fade-quick" />
      )}

      {particles.map((p) => (
        <span
          key={p.id}
          className="absolute select-none will-change-transform"
          style={{
            left: `${p.left}%`,
            bottom: tier === 'highStakes' ? 'auto' : '-60px',
            top: tier === 'highStakes' ? '-60px' : 'auto',
            fontSize: `${p.size}px`,
            animation: `${
              tier === 'highStakes' ? 'buyin-rain' : 'buyin-burst'
            } ${p.duration}ms cubic-bezier(0.2, 0.7, 0.4, 1) ${p.delay}ms forwards`,
            // CSS custom props consumed by the keyframes below
            ['--drift' as any]: `${p.drift}px`,
            ['--rot' as any]: `${p.rotate}deg`,
          }}
        >
          {p.emoji}
        </span>
      ))}

      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pop">
        <div
          className={`px-6 py-4 rounded-2xl bg-slate-950/80 backdrop-blur-md border border-white/10 shadow-2xl ${cfg.glow} text-center`}
        >
          <p className={`text-base font-black ${cfg.tint} tracking-tight`}>
            {cfg.message}
          </p>
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">
            {cfg.subMessage}
          </p>
        </div>
      </div>

      <style>{`
        @keyframes buyin-burst {
          0%   { transform: translate(0, 0) rotate(0deg); opacity: 0; }
          10%  { opacity: 1; }
          100% { transform: translate(var(--drift), -110vh) rotate(var(--rot)); opacity: 0; }
        }
        @keyframes buyin-rain {
          0%   { transform: translate(0, 0) rotate(0deg); opacity: 0; }
          10%  { opacity: 1; }
          100% { transform: translate(var(--drift), 110vh) rotate(var(--rot)); opacity: 0; }
        }
        @keyframes buyin-pop {
          0%   { transform: translate(-50%, -50%) scale(0.6); opacity: 0; }
          20%  { transform: translate(-50%, -50%) scale(1.05); opacity: 1; }
          80%  { transform: translate(-50%, -50%) scale(1); opacity: 1; }
          100% { transform: translate(-50%, -50%) scale(0.95); opacity: 0; }
        }
        @keyframes fade-quick { 0% { opacity: 0; } 20% { opacity: 1; } 100% { opacity: 0; } }
        .animate-pop       { animation: buyin-pop 2400ms ease forwards; }
        .animate-fade-quick{ animation: fade-quick 2600ms ease forwards; }
        .bg-gradient-radial{ background: radial-gradient(circle at 50% 50%, var(--tw-gradient-stops)); }
      `}</style>
    </div>
  );
}
