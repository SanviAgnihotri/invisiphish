import React from 'react';
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'framer-motion';
import { Brand } from '@/components/Brand';

interface AuthLayoutProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

/** The beam: bright at its leading edge, fading away behind it. */
const SWEEP_BACKGROUND =
  'conic-gradient(from 0deg, transparent 0deg, rgba(244, 63, 94, 0.04) 268deg, rgba(244, 63, 94, 0.10) 322deg, rgba(244, 63, 94, 0.20) 352deg, rgba(255, 255, 255, 0.26) 359.4deg, transparent 360deg)';

/** The mask that keeps the beam inside the outermost range ring. */
const SWEEP_MASK =
  'radial-gradient(circle at 50% 50%, black 0 45%, transparent 47.5%)';

/** Faint contacts on the field: noise, mostly. */
const CONTACTS = [
  { left: '26%', top: '64%', delay: '0.2s' },
  { left: '73%', top: '56%', delay: '1.3s' },
  { left: '44%', top: '18%', delay: '2.4s' },
  { left: '80%', top: '33%', delay: '3.2s' },
];

/**
 * The radar motif for the dark panel: a scanning instrument that has just
 * locked onto one signal. The beam sweeps, the field breathes, and the single
 * detected point is the only thing in red.
 */
const SignalVisual: React.FC = () => {
  const reduced = useReducedMotion() ?? false;
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const springX = useSpring(pointerX, { stiffness: 70, damping: 20, mass: 0.6 });
  const springY = useSpring(pointerY, { stiffness: 70, damping: 20, mass: 0.6 });
  const shiftX = useTransform(springX, [-1, 1], [-9, 9]);
  const shiftY = useTransform(springY, [-1, 1], [-9, 9]);

  const handleMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (reduced) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    pointerX.set((event.clientX - bounds.left) / bounds.width - 0.5);
    pointerY.set((event.clientY - bounds.top) / bounds.height - 0.5);
  };

  const handleLeave = () => {
    pointerX.set(0);
    pointerY.set(0);
  };

  const ticks = Array.from({ length: 48 }, (_, i) => i * 7.5);

  return (
    <div
      className="relative mx-auto aspect-square w-full max-w-md"
      onPointerMove={handleMove}
      onPointerLeave={handleLeave}
    >
      <motion.div className="absolute inset-0" style={reduced ? undefined : { x: shiftX, y: shiftY }}>
        {/* the glow the beam paints on the glass */}
        <div className="absolute inset-[22%] rounded-full bg-red-500/[0.05] blur-3xl" />

        {/* the sweeping beam */}
        <div
          className="radar-sweep absolute inset-0 rounded-full"
          style={{
            background: SWEEP_BACKGROUND,
            maskImage: SWEEP_MASK,
            WebkitMaskImage: SWEEP_MASK,
          }}
        />

        <svg viewBox="0 0 400 400" fill="none" className="absolute inset-0 h-full w-full">
          {/* sweeping axis */}
          <line x1="200" y1="8" x2="200" y2="392" stroke="#27272a" strokeOpacity="0.5" />
          <line x1="8" y1="200" x2="392" y2="200" stroke="#27272a" strokeOpacity="0.5" />

          {/* range rings */}
          <circle cx="200" cy="200" r="188" stroke="#27272a" strokeDasharray="1 6" />
          <circle cx="200" cy="200" r="140" stroke="#27272a" />
          <circle cx="200" cy="200" r="92" stroke="#27272a" />
          <circle cx="200" cy="200" r="44" stroke="#3f3f46" />

          {/* graduation ticks */}
          {ticks.map((deg) => (
            <line
              key={deg}
              x1="200"
              y1="12"
              x2="200"
              y2={deg % 90 === 0 ? '26' : '20'}
              stroke={deg % 90 === 0 ? '#52525b' : '#3f3f46'}
              strokeWidth={deg % 90 === 0 ? 2 : 1}
              transform={`rotate(${deg} 200 200)`}
            />
          ))}

          <circle cx="200" cy="200" r="2.5" fill="#52525b" />
        </svg>

        {/* everything else on the field */}
        {CONTACTS.map((contact) => (
          <span
            key={`${contact.left}-${contact.top}`}
            className="radar-blink absolute size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-500"
            style={{ left: contact.left, top: contact.top, animationDelay: contact.delay }}
          />
        ))}

        {/* the one signal that matters */}
        <span
          aria-hidden
          className="absolute size-2 -translate-x-1/2 -translate-y-1/2"
          style={{ left: '68%', top: '30%' }}
        >
          <span className="radar-halo block size-2 rounded-full bg-red-400/70" />
        </span>
        <span
          aria-hidden
          className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500"
          style={{ left: '68%', top: '30%' }}
        />
        <span
          aria-hidden
          className="absolute h-px w-4 bg-zinc-700"
          style={{ left: '69.5%', top: '30%' }}
        />

        <span className="absolute whitespace-nowrap" style={{ left: '75%', top: '22%' }}>
          <span className="inline-block rounded-md border border-zinc-800 bg-zinc-900/90 px-1.5 py-0.5 text-[10px] font-medium text-red-400 backdrop-blur-sm">
            phishing detected
          </span>
          <span className="mt-1 block font-mono text-[9.5px] tracking-tight text-zinc-500">
            ev_url_1_suspicious_tld · 0.94
          </span>
        </span>
      </motion.div>
    </div>
  );
};

/**
 * Split auth shell.
 *
 * The form sits on the left half; the right half is a quiet instrument panel -
 * the scanning motif of the product, with a single locked contact. On small
 * screens the panel is dropped and the brand moves above the form.
 */
export const AuthLayout: React.FC<AuthLayoutProps> = ({ title, subtitle, children }) => (
  <div className="grid min-h-screen lg:grid-cols-2">
    {/* Left: the form */}
    <div className="flex flex-col px-4 py-12 sm:px-6">
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center">
        {/* The panel carries the brand on wide screens; here it stands in. */}
        <div className="flex justify-center lg:hidden">
          <Brand className="h-6" />
        </div>

        <div className="mt-6 text-center lg:mt-0">
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-950">{title}</h2>
          {subtitle && <p className="mt-1.5 text-sm text-zinc-500">{subtitle}</p>}
        </div>

        <div className="mt-6">{children}</div>
      </div>
    </div>

    {/* Right: the instrument panel */}
    <aside className="relative hidden overflow-hidden bg-zinc-950 p-10 text-white lg:flex lg:flex-col xl:p-14">
      {/* the room the instrument sits in */}
      <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-zinc-800/40 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -left-24 h-80 w-80 rounded-full bg-zinc-800/25 blur-3xl" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.15]">
        <div
          className="h-full w-full"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(113,113,122,0.16) 1px, transparent 1px), linear-gradient(to bottom, rgba(113,113,122,0.16) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage: 'radial-gradient(70% 60% at 50% 45%, black, transparent 80%)',
            WebkitMaskImage: 'radial-gradient(70% 60% at 50% 45%, black, transparent 80%)',
          }}
        />
      </div>

      {/* the mark */}
      <div className="relative">
        <Brand light />
      </div>

      <div className="relative flex flex-1 items-center justify-center py-6">
        <SignalVisual />
      </div>

      <div className="relative space-y-1.5">
        <p className="text-lg font-medium tracking-tight text-white">
          Evidence-first phishing detection.
        </p>
        <p className="text-sm text-white/50">Four modules. One verdict. Every claim cites evidence.</p>
      </div>
    </aside>
  </div>
);
