/**
 * The landing demo: a scan console that replays an example scan.
 *
 * It uses the very same event protocol the dashboard consumes - the demo
 * emits `summary` / `bullet-delta` / `bullet` / `action` / `done` through
 * `applyExplanationEvent`, so what a visitor watches is exactly what the
 * product does, not a picture of it. Each finished claim lights up the
 * evidence it cites, which is the product's actual guarantee on stage.
 *
 * The layout is the dashboard's own: the rationale on the left, the evidence
 * rail on the right, framed as the window it is.
 *
 * Three example scans are on file - a phishing one, a suspicious one and a
 * legitimate one - and the page shows the next one each time it is loaded, so
 * the demo says what the product does with ordinary mail as well as with the
 * obvious fraud.
 */

import React, { useEffect, useRef, useState } from 'react';
import { motion, useInView, useReducedMotion } from 'framer-motion';
import { Check } from 'lucide-react';
import { applyExplanationEvent, emptyExplainState, type ExplanationStreamEvent, type ExplainStreamState } from '@/lib/api';

type Tone = 'phishing' | 'suspicious' | 'legitimate';

interface DemoScript {
  tone: Tone;
  verdict: string;
  confidence: string;
  score: string;
  summary: string;
  bullets: { text: string; evidenceIds: string[] }[];
  actions: string[];
  evidence: { id: string; label: string; score: string }[];
}

/** How each verdict is dressed: the chip, and the evidence it lights up. */
const TONES: Record<Tone, { chip: string; lit: string }> = {
  phishing: {
    chip: 'bg-red-50 text-red-700',
    lit: 'border-red-500/25 bg-red-500/[0.05]',
  },
  suspicious: {
    chip: 'bg-amber-50 text-amber-700',
    lit: 'border-amber-500/25 bg-amber-500/[0.05]',
  },
  legitimate: {
    chip: 'bg-emerald-50 text-emerald-700',
    lit: 'border-emerald-500/25 bg-emerald-500/[0.05]',
  },
};

const SCRIPTS: DemoScript[] = [
  {
    tone: 'phishing',
    verdict: 'Phishing',
    confidence: '61%',
    score: '72.4',
    summary:
      'This message was flagged as phishing because it invents an account lock, applies time pressure, and pushes the reader to an unencrypted page whose address carries common phishing traits.',
    bullets: [
      {
        text: 'It claims the recipient\u2019s account has been locked — a cue for impersonating a legitimate authority.',
        evidenceIds: ['ev_intent_authority'],
      },
      {
        text: 'A semantic classifier assigned the message a 100% phishing probability.',
        evidenceIds: ['ev_semantic_score'],
      },
      {
        text: 'The link goes to a \u2018termpay\u2019 campaign token with a \u2018login\u2019 path, a pattern strongly associated with credential harvesting.',
        evidenceIds: ['ev_url_1_suspicious_path'],
      },
      {
        text: 'The page is not encrypted, so anything typed there is visible on the network.',
        evidenceIds: ['ev_url_1_no_https'],
      },
    ],
    actions: [
      'Do not click any link in this message.',
      'Report it to your security team, then delete it.',
    ],
    evidence: [
      { id: 'ev_semantic_score', label: 'Contextual semantic classification', score: '100%' },
      { id: 'ev_intent_authority', label: 'Impersonation of a legitimate authority', score: '85%' },
      { id: 'ev_url_1_suspicious_path', label: 'Structural signals of the link', score: '94%' },
      { id: 'ev_url_1_no_https', label: 'No transport encryption', score: '68%' },
    ],
  },
  {
    tone: 'suspicious',
    verdict: 'Suspicious',
    confidence: '68%',
    score: '57.6',
    summary:
      'This message was read as suspicious rather than phishing: the pressure and the link structure are wrong for a routine notice, but no claim in it impersonates anyone.',
    bullets: [
      {
        text: 'It sets a deadline — the parcel is returned unless details are confirmed today.',
        evidenceIds: ['ev_intent_scarcity'],
      },
      {
        text: 'The tracking link hides its real host behind a redirect, so the destination cannot be read from the address.',
        evidenceIds: ['ev_url_1_ratio'],
      },
      {
        text: 'The page it points to is served without encryption, so anything typed there is visible on the network.',
        evidenceIds: ['ev_url_1_no_https'],
      },
      {
        text: 'A semantic classifier rated the message as mildly phishing-like, at 62%.',
        evidenceIds: ['ev_semantic_score'],
      },
    ],
    actions: [
      'Open the tracking link from the courier\u2019s own site, not from the message.',
      'Report the message to your security team, then delete it.',
    ],
    evidence: [
      { id: 'ev_semantic_score', label: 'Contextual semantic classification', score: '62%' },
      { id: 'ev_intent_scarcity', label: 'Scarcity and deadline pressure', score: '72%' },
      { id: 'ev_url_1_ratio', label: 'Redirect hides the destination', score: '66%' },
      { id: 'ev_url_1_no_https', label: 'No transport encryption', score: '68%' },
    ],
  },
  {
    tone: 'legitimate',
    verdict: 'Likely legitimate',
    confidence: '86%',
    score: '3.8',
    summary:
      'This message was read as legitimate: it names a domain the recipient already works with, and carries none of the pressure the other messages carried.',
    bullets: [
      {
        text: 'The only link points at the company domain, not at a lookalike.',
        evidenceIds: ['ev_url_1_known_domain'],
      },
      {
        text: 'No urgency, threat, authority or reward cues were found in the wording.',
        evidenceIds: ['ev_intent_neutral'],
      },
      {
        text: 'The pattern it matches is a common internal notice, which the pattern miner has seen many times.',
        evidenceIds: ['ev_pattern_common'],
      },
      {
        text: 'A semantic classifier assigned the message a 4% phishing probability.',
        evidenceIds: ['ev_semantic_score'],
      },
    ],
    actions: [
      'No action needed — nothing in this message asks for anything.',
      'Keep it, and report it only if the sender\u2019s address changes.',
    ],
    evidence: [
      { id: 'ev_semantic_score', label: 'Contextual semantic classification', score: '4%' },
      { id: 'ev_url_1_known_domain', label: 'Link points at a known domain', score: '2%' },
      { id: 'ev_intent_neutral', label: 'No pressure cues detected', score: '4%' },
      { id: 'ev_pattern_common', label: 'Matches a common internal notice', score: '2%' },
    ],
  },
];

const MODEL = 'glm-5.3-flash';

/**
 * The next example in the rotation. The counter lives in the session, so a
 * visitor who reloads the page sees a different scan - a page that always
 * shows the same failure teaches nothing about the other two thirds.
 *
 * The choice is remembered for the lifetime of the module: React runs a
 * state initialiser twice in development, and the rotation must not advance
 * twice for one page view.
 */
let chosen: DemoScript | null = null;

function nextScript(): DemoScript {
  if (chosen) return chosen;

  const key = 'vigil-demo-scan';
  let index = 0;

  // A prerendered page carries the example it was built with, so the markup
  // the browser already holds is the markup React renders.
  const prerendered =
    typeof document === 'undefined' ? undefined : document.getElementById('root')?.dataset.demoIndex;

  if (prerendered !== undefined) {
    index = Number(prerendered) || 0;
  } else {
    try {
      index = Number(sessionStorage.getItem(key) ?? 0) || 0;
      sessionStorage.setItem(key, String(index + 1));
    } catch {
      // Storage can be unavailable (private mode); the first example stands.
    }
  }

  chosen = SCRIPTS[index % SCRIPTS.length];
  return chosen;
}

const CHUNK = 3;
const TICK_MS = 26;

/** One replay of an example scan: every emission is a real protocol event.
 *  Returns the clock time when the replay finishes emitting. */
function scheduleCycle(
  script: DemoScript,
  emit: (event: ExplanationStreamEvent) => void,
  reduced: boolean,
  timers: number[],
): number {
  const at = (delay: number, fn: () => void) => timers.push(window.setTimeout(fn, delay));

  emit({ type: 'model', model: MODEL });

  if (reduced) {
    // Motion is not welcome: deliver the whole object at once.
    emit({ type: 'summary', text: script.summary });
    script.bullets.forEach((bullet, index) => {
      emit({ type: 'bullet', index, text: bullet.text, evidenceIds: bullet.evidenceIds });
    });
    script.actions.forEach((action, index) => {
      emit({ type: 'action', index, text: action });
    });
    emit({
      type: 'done',
      explanation: {
        summary: script.summary,
        bullets: script.bullets,
        recommendedActions: script.actions,
      },
      groundedness: {
        score: 1,
        validBullets: script.bullets.length,
        invalidBullets: 0,
        unknownEvidenceIds: [],
        droppedBullets: [],
      },
      removedBulletIndexes: [],
      generated: true,
      model: MODEL,
    });
    return 0;
  }

  let t = 450; // the skeleton beat

  const streamText = (text: string, since: number, target: (piece: string) => void): number => {
    let cursor = 0;
    let clock = since;
    while (cursor < text.length) {
      const take = CHUNK + (cursor % 2); // a steady, slightly uneven cadence
      const piece = text.slice(cursor, cursor + take);
      at(clock, () => target(piece));
      cursor += take;
      clock += TICK_MS;
    }
    return clock;
  };

  t = streamText(script.summary, t, (piece) => emit({ type: 'summary', text: piece }));

  script.bullets.forEach((bullet, index) => {
    t = streamText(bullet.text, t, (piece) =>
      emit({ type: 'bullet-delta', index, text: piece }),
    );
    at(t, () =>
      emit({ type: 'bullet', index, text: bullet.text, evidenceIds: bullet.evidenceIds }),
    );
    t += 180; // a breath between claims
  });

  script.actions.forEach((action, index) => {
    t += 240;
    // The action is written out like the claims, not dropped in whole.
    const written = streamText(action, t, (piece) =>
      emit({ type: 'action-delta', index, text: piece }),
    );
    t = written;
    at(t, () => emit({ type: 'action', index, text: action }));
  });

  at(t + 150, () => {
    emit({
      type: 'done',
      explanation: {
        summary: script.summary,
        bullets: script.bullets,
        recommendedActions: script.actions,
      },
      groundedness: {
        score: 1,
        validBullets: script.bullets.length,
        invalidBullets: 0,
        unknownEvidenceIds: [],
        droppedBullets: [],
      },
      removedBulletIndexes: [],
      generated: true,
      model: MODEL,
    });
  });

  return t + 150;
}

export const ScanConsole: React.FC = () => {
  const [script] = useState<DemoScript>(() => nextScript());
  const [stream, setStream] = useState<ExplainStreamState>(() => emptyExplainState());
  const [cited, setCited] = useState<string[]>([]);
  const reduced = useReducedMotion();
  const tone = TONES[script.tone];

  // The replay runs once, when the console first comes into view, and then
  // stays on its finished state. Looping it would make the page feel like a
  // screensaver and would keep the eye off the rest of the page.
  const holder = useRef<HTMLDivElement>(null);
  const inView = useInView(holder, { once: true, margin: '-120px' });

  useEffect(() => {
    if (!inView) return;

    const timers: number[] = [];
    let citedSnapshot: string[] = [];

    setCited([]);
    setStream({ ...emptyExplainState(), phase: 'connecting' });

    const watching = (event: ExplanationStreamEvent) => {
      if (event.type === 'bullet') {
        citedSnapshot = [...citedSnapshot, ...event.evidenceIds];
        setCited(citedSnapshot);
      }
      setStream((state) => applyExplanationEvent(state, event));
    };

    scheduleCycle(script, watching, reduced ?? false, timers);

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [inView, reduced, script]);

  const streaming = stream.phase === 'connecting' || stream.phase === 'streaming';
  const done = stream.phase === 'done';
  const lastBulletDone = stream.bullets.length > 0 && stream.bullets.every((b) => b.evidenceIds.length > 0);

  const caret = (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse rounded-full bg-zinc-400 align-middle"
    />
  );

  return (
    <div ref={holder} className="relative mx-auto mt-14 max-w-4xl">
      {/* the aura behind the window */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-10 -top-16 -z-10 h-72 blur-3xl"
        style={{
          background:
            'radial-gradient(38% 52% at 26% 30%, rgba(244, 63, 94, 0.08), transparent 72%), radial-gradient(34% 46% at 78% 24%, rgba(113, 113, 122, 0.12), transparent 72%)',
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_1px_2px_rgba(9,9,11,0.04),0_18px_48px_-20px_rgba(9,9,11,0.16)]"
      >
        {/* the window chrome */}
        <div className="flex h-9 items-center gap-2.5 border-b border-zinc-200 bg-zinc-50/80 px-4">
          <span className="flex gap-1.5">
            <span className="size-2 rounded-full bg-zinc-300/70" />
            <span className="size-2 rounded-full bg-zinc-300/70" />
            <span className="size-2 rounded-full bg-zinc-300/70" />
          </span>

          <span className="ml-1 text-[11.5px] font-semibold tracking-tight text-zinc-800">Vigil</span>
          <span className="text-[11.5px] text-zinc-400">Message analysis</span>

          <span className="ml-auto flex items-center gap-2.5">
            {done ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-600">
                <Check className="h-3 w-3 text-emerald-600" />
                Verified
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-zinc-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-zinc-500" />
                </span>
                {streaming ? 'Streaming' : 'Connecting'}
              </span>
            )}
          </span>
        </div>

        <div className="grid lg:grid-cols-[1fr_296px]">
          {/* ------- the verdict and the streamed rationale ------- */}
          <div className="p-6 text-left sm:p-8">
            <div className="flex items-start justify-between gap-6">
              <div>
                <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${tone.chip}`}>
                  {script.verdict}
                </span>
                <p className="mt-3 text-[44px] font-semibold leading-none tabular-nums tracking-tight text-zinc-950">
                  {script.score}
                  <span className="text-xl text-zinc-300">%</span>
                </p>
                <p className="mt-2 text-sm text-zinc-500">phishing risk</p>
                <p className="mt-3 text-xs text-zinc-400">Four modules agree on this score.</p>
              </div>

              <div className="text-right">
                <p className="text-[10.5px] uppercase tracking-wider text-zinc-400">Confidence</p>
                <p className="mt-1 text-xl font-medium tabular-nums text-zinc-900">{script.confidence}</p>
              </div>
            </div>

            <div className="mt-7 border-t border-zinc-100 pt-6">
              <div className="flex items-center justify-between gap-4">
                <h3 className="text-[10.5px] font-medium uppercase tracking-wider text-zinc-400">
                  Why this verdict
                </h3>
                {done && (
                  <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500">
                    grounded 100%
                  </span>
                )}
              </div>

              {streaming && stream.summary.length === 0 && (
                <div className="mt-3 space-y-2" aria-hidden="true">
                  <div className="h-3 w-11/12 animate-pulse rounded bg-zinc-100" />
                  <div className="h-3 w-7/12 animate-pulse rounded bg-zinc-100" />
                </div>
              )}

              {stream.summary.length > 0 && (
                <p className="mt-3 text-[14.5px] leading-relaxed text-zinc-900">
                  {stream.summary}
                  {streaming && stream.bullets.length === 0 && caret}
                </p>
              )}

              {stream.bullets.length > 0 && (
                <ul className="mt-4 space-y-3">
                  {stream.bullets.map((bullet, at) => (
                    <motion.li
                      key={bullet.index}
                      initial={{ opacity: 0.55, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.25 }}
                      className="flex items-start gap-2.5 text-[13.5px]"
                    >
                      <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-zinc-300" />
                      <span className="text-zinc-600">
                        {bullet.text}
                        {streaming && at === stream.bullets.length - 1 && !lastBulletDone && caret}
                      </span>
                    </motion.li>
                  ))}
                </ul>
              )}

              {stream.actions.length > 0 && (
                <div className="mt-6 border-t border-zinc-100 pt-4">
                  <p className="text-[10.5px] font-medium uppercase tracking-wider text-zinc-400">
                    What to do
                  </p>
                  <ol className="mt-2.5 space-y-2">
                    {stream.actions.map((action, index) => (
                      <li key={index} className="flex items-start gap-2.5 text-[13.5px] leading-snug text-zinc-700">
                        <span className="mt-px grid size-4 shrink-0 place-items-center rounded bg-zinc-100 font-mono text-[10px] tabular-nums text-zinc-500">
                          {index + 1}
                        </span>
                        <span>
                          {action}
                          {streaming && index === stream.actions.length - 1 && caret}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          </div>

          {/* ------- the evidence the claims cite ------- */}
          <div className="border-t border-zinc-100 bg-zinc-50/40 p-6 sm:p-8 lg:border-l lg:border-t-0">
            <div className="flex items-center justify-between">
              <p className="text-[10.5px] font-medium uppercase tracking-wider text-zinc-400">
                Evidence
              </p>
              <span className="font-mono text-[10.5px] text-zinc-400">{script.evidence.length} items</span>
            </div>

            <ul className="mt-3 space-y-2">
              {script.evidence.map((item) => {
                const lit = cited.includes(item.id);
                return (
                  <li
                    key={item.id}
                    className={`rounded-lg border px-3 py-2.5 transition-colors duration-500 ${
                      lit ? tone.lit : 'border-zinc-200/70 bg-white'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-[13px] font-medium leading-snug text-zinc-900">{item.label}</p>
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-400">
                        {item.score}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-[10.5px] text-zinc-400">{item.id}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </motion.div>

      <p className="mt-4 text-center text-xs text-zinc-400">
        A replayed example — the rationale really streams in the app, claim by claim.
      </p>
    </div>
  );
};
