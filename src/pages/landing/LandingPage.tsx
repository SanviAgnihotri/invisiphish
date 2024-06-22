import React from 'react';
import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Brand } from '@/components/Brand';
import { ScanConsole } from '@/pages/landing/ScanConsole';

/** The three rules that make the explanation auditable. */
const GROUNDING: { label: string; value: string }[] = [
  {
    label: 'What the model receives',
    value: 'the evidence table only — never the raw message',
  },
  {
    label: 'What a claim must carry',
    value: 'the ids of the evidence it rests on, or it is dropped',
  },
  {
    label: 'What reaches the screen',
    value: 'streamed text, pruned at the end, with a groundedness figure',
  },
];

/** Linear-style hero glow + a faint engineering grid, both fading out downward. */
const HeroBackdrop: React.FC = () => (
  <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[760px] -z-10 overflow-hidden">
    <div
      className="absolute inset-0"
      style={{
        background:
          'radial-gradient(52% 44% at 50% 0%, rgba(244, 63, 94, 0.07), transparent 72%), radial-gradient(38% 30% at 68% 6%, rgba(251, 146, 60, 0.05), transparent 70%)',
      }}
    />
    <div
      className="absolute inset-0 opacity-[0.35]"
      style={{
        backgroundImage:
          'linear-gradient(to right, rgba(113,113,122,0.14) 1px, transparent 1px), linear-gradient(to bottom, rgba(113,113,122,0.14) 1px, transparent 1px)',
        backgroundSize: '56px 56px',
        maskImage: 'radial-gradient(74% 56% at 50% 0%, black, transparent 78%)',
        WebkitMaskImage: 'radial-gradient(74% 56% at 50% 0%, black, transparent 78%)',
      }}
    />
  </div>
);

/** A row rises as it enters the viewport. */
const Reveal: React.FC<{ children: React.ReactNode; className?: string; delay?: number }> = ({
  children,
  className,
  delay = 0,
}) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    whileInView={{ opacity: 1, y: 0 }}
    viewport={{ once: true, margin: '-60px' }}
    transition={{ duration: 0.65, delay, ease: [0.22, 1, 0.36, 1] }}
    className={className}
  >
    {children}
  </motion.div>
);

export const LandingPage: React.FC = () => {
  return (
    <div className="min-h-screen bg-white text-zinc-950">
      <HeroBackdrop />

      {/* ---------- Nav ---------- */}
      <header className="sticky top-0 z-40 border-b border-zinc-200/70 bg-white/80 backdrop-blur-md">
        <nav className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <Brand />
          <div className="flex items-center gap-1.5">
            <Link
              to="/login"
              className="px-3 text-sm text-zinc-500 transition-colors hover:text-zinc-950"
            >
              Log in
            </Link>
            <Link to="/register" className="btn-primary h-8">
              Get started
            </Link>
          </div>
        </nav>
      </header>

      <main>
        {/* ---------- Hero ---------- */}
        <section className="relative mx-auto max-w-5xl px-6 pb-24 pt-24 text-center">
          <Reveal>
            <h1 className="mx-auto max-w-3xl text-balance text-[clamp(42px,7vw,76px)] font-semibold leading-[1.02] tracking-[-0.03em]">
              Phishing detection, with{' '}
              <span className="bg-gradient-to-b from-zinc-950 to-zinc-500 bg-clip-text text-transparent">
                its reasoning shown.
              </span>
            </h1>
          </Reveal>

          <Reveal delay={0.14}>
            <div className="mt-9 flex items-center justify-center">
              <Link to="/register" className="btn-primary h-10 px-5">
                Start scanning
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </Reveal>

          {/* the product, playing itself */}
          <ScanConsole />
        </section>

        {/* ---------- Grounding ---------- */}
        <section id="grounded" className="border-t border-zinc-200 bg-zinc-50/60 py-20">
          <div className="mx-auto max-w-2xl px-6">
            <Reveal>
              <p className="text-center text-xs font-medium uppercase tracking-wider text-red-600/80">
                The grounding guarantee
              </p>
              <h2 className="mt-3 text-center text-[clamp(26px,3.4vw,34px)] font-semibold leading-tight tracking-[-0.02em]">
                The model writes, but the evidence decides.
              </h2>
              <p className="mt-4 text-center text-[15px] leading-relaxed text-zinc-500">
                The model never sees the message — only the sealed evidence table. Every claim it
                streams must name the evidence ids it rests on, and a claim that cannot be traced back
                is removed before the final reading.
              </p>
            </Reveal>

            <Reveal delay={0.08}>
              <div className="card mt-10 divide-y divide-zinc-100">
                {GROUNDING.map((row) => (
                  <div key={row.label} className="px-5 py-4">
                    <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                      {row.label}
                    </p>
                    <p className="mt-1 text-sm text-zinc-900">{row.value}</p>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      {/* ---------- Footer ---------- */}
      <footer className="relative overflow-hidden border-t border-zinc-200">
        <div className="mx-auto flex max-w-5xl items-center justify-center px-6 py-8">
          <p className="text-xs text-zinc-400">© {new Date().getFullYear()} Vigil — evidence-first phishing detection</p>
        </div>
        <p
          aria-hidden
          className="pointer-events-none select-none text-center text-[clamp(96px,17vw,240px)] font-semibold leading-[0.72] tracking-[-0.05em] text-zinc-950/[0.04]"
        >
          VIGIL
        </p>
      </footer>
    </div>
  );
};
