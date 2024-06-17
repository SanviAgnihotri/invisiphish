/**
 * Evidence-grounded explanation generation, streamed.
 *
 * This is the paper's explainability contribution, implemented.
 *
 * Three properties matter here:
 *
 * 1. The model never sees the raw message. It receives a closed table of
 *    evidence that the pipeline already computed, so there is no
 *    attacker-controlled text in the prompt and therefore no prompt-injection
 *    surface at this step.
 *
 * 2. Every claim must cite evidence ids, and the output is validated against
 *    the evidence table afterwards. A claim that cannot be traced back to
 *    computed evidence is removed from the final reading. What the reader saw
 *    while streaming may therefore change: the `done` event names the claims
 *    that did not survive.
 *
 * 3. The answer reaches the browser as it is being written. The response is a
 *    constrained JSON object, so the stream is scanned character by
 *    character, and the meaningful pieces - the summary, every bullet, every
 *    recommended action - are announced while the model is still writing.
 */

import {
  RECOMMENDED_ACTIONS,
  buildEvidenceTable,
  validateExplanation,
} from '../../src/lib/validation/groundedness';
import type { Evidence, Explanation, GroundednessReport } from '../../src/lib/ml/types';

const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
/**
 * The models the explanation layer tries, in order.
 *
 * The first is the one it wants: `glm-5.3-flash` is cheap, fast, and it
 * answers with the object the schema asks for. The rest are backups, for the
 * two ways a model can let the application down - the service can refuse the
 * request, and a model can answer in prose instead of in the object the
 * schema asks for - neither of which should leave the reader without an
 * explanation.
 */
const OPENCODE_MODELS = [
  'glm-5.3-flash',
  'mimo-v2.6-flash',
  'qwen3.8-flash',
  'mimo-v2.5',
  'hy3',
  'longcat-2.0',
] as const;

/**
 * The models to try.
 *
 * `OPENCODE_MODEL` names the one to start with; the rest of the chain is
 * used when it fails. `OPENCODE_MODELS` overrides the whole chain, which is
 * how a deployment pins the set it has been tested against.
 */
function openCodeModels(): string[] {
  const override = process.env.OPENCODE_MODELS?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (override && override.length > 0) return override;

  const primary = process.env.OPENCODE_MODEL?.trim();
  if (!primary) return [...OPENCODE_MODELS];

  return [primary, ...OPENCODE_MODELS.filter((model) => model !== primary)];
}
const DEFAULT_OPENCODE_BASE_URL = 'https://opencode.ai/inference/go/openai/v1';

/**
 * A stable id for this process's conversations.
 *
 * OpenCode Go routes on it and uses it for prompt caching, so it must not
 * change from request to request.
 */
const OPENCODE_SESSION_ID = `invisiphish-explain-${process.pid}`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'One or two sentences describing why the message is risky.',
    },
    bullets: {
      type: 'array',
      description: 'Short factual findings, each citing the evidence it rests on.',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'A single factual finding.' },
          evidenceIds: {
            type: 'array',
            description: 'The ids of the evidence items that support this finding.',
            items: { type: 'string' },
          },
        },
        required: ['text', 'evidenceIds'],
      },
    },
    recommendedActions: {
      type: 'array',
      description: 'Actions the reader should take, taken verbatim from the allowed list.',
      items: { type: 'string' },
    },
  },
  required: ['summary', 'bullets', 'recommendedActions'],
} as const;

const SYSTEM_INSTRUCTION = `You explain phishing detections to non-technical readers.

Rules:
- Use ONLY the facts in the EVIDENCE table. Never add a fact that is not in it.
- Every bullet must cite the evidence ids it rests on. A bullet with no citation is rejected.
- Do not speculate about the sender, the motive, or anything the evidence does not show.
- Keep each bullet to one sentence.
- Recommended actions must be copied verbatim from the ALLOWED ACTIONS list.
- If the evidence is weak, say so plainly rather than overstating the risk.

Answer with one JSON object and nothing else. No prose before it, no prose after it, no markdown fence around it:
{"summary": "<one or two sentences>", "bullets": [{"text": "<one factual finding>", "evidenceIds": ["<id>"]}], "recommendedActions": ["<an action copied verbatim from the ALLOWED ACTIONS list>"]}`;

export interface ExplainOutcome {
  explanation: Explanation;
  groundedness: GroundednessReport;
  /** True when a real model produced the text; false in mock mode. */
  generated: boolean;
  model?: string;
}

/**
 * The events the streamed generation emits, in order.
 *
 * `summary`, `bullet-delta` and `action-delta` bring the text as it is
 * written. `bullet` announces a finished bullet, with the evidence ids it
 * will be judged by. `action` announces one finished recommended action.
 * `done` is authoritative: it
 * carries the fully validated object, the groundedness report and the
 * indexes of the streamed bullets that did not survive validation.
 */
export type ExplanationStreamEvent =
  | { type: 'model'; model: string }
  | { type: 'summary'; text: string }
  | { type: 'bullet-delta'; index: number; text: string }
  | { type: 'bullet'; index: number; text: string; evidenceIds: string[] }
  | { type: 'action-delta'; index: number; text: string }
  | { type: 'action'; index: number; text: string }
  | { type: 'error'; message: string }
  | {
      type: 'done';
      explanation: Explanation;
      groundedness: GroundednessReport;
      removedBulletIndexes: number[];
      generated: boolean;
      model?: string;
    };

export type ExplanationEmitter = (event: ExplanationStreamEvent) => void;

function buildPrompt(evidence: Evidence[], verdict: string, score: number): string {
  const allowed = RECOMMENDED_ACTIONS.map((action) => `- ${action.text}`).join('\n');

  return `The detection classified this message as "${verdict}" with a phishing score of ${(
    score * 100
  ).toFixed(1)}%.

EVIDENCE
${buildEvidenceTable(evidence)}

ALLOWED ACTIONS
${allowed}

Write the explanation.`;
}

/** Deterministic fallback used when no API key is configured. */
function mockExplanation(evidence: Evidence[], verdict: string, score: number): Explanation {
  const bullets = evidence.slice(0, 4).map((item) => ({
    text: `${item.label}. ${item.detail}`,
    evidenceIds: [item.id],
  }));

  return {
    summary: `This message was classified as ${verdict} with a phishing score of ${(score * 100).toFixed(
      1,
    )}%, based on ${evidence.length} computed signal${evidence.length === 1 ? '' : 's'}.`,
    bullets,
    recommendedActions: [],
  };
}

/**
 * Replay a finished explanation through the stream.
 *
 * Used by the non-streaming providers (Gemini) and by mock mode, so the
 * reader sees the same events whichever provider answered.
 */
function replayExplanation(explanation: Explanation, emit: ExplanationEmitter): void {
  if (explanation.summary) emit({ type: 'summary', text: explanation.summary });

  explanation.bullets.forEach((bullet, index) => {
    emit({ type: 'bullet-delta', index, text: bullet.text });
    emit({ type: 'bullet', index, text: bullet.text, evidenceIds: bullet.evidenceIds });
  });

  explanation.recommendedActions.forEach((action, index) => {
    emit({ type: 'action-delta', index, text: action });
    emit({ type: 'action', index, text: action });
  });
}

/** Whether an event carries text the reader will see. */
function isReaderVisible(event: ExplanationStreamEvent): boolean {
  return (
    event.type === 'summary' ||
    event.type === 'bullet-delta' ||
    event.type === 'bullet' ||
    event.type === 'action-delta' ||
    event.type === 'action'
  );
}

/* ------------------------------------------------------------------ */
/* The JSON stream scanner                                             */
/* ------------------------------------------------------------------ */

/**
 * A character-level reader for the constrained explanation object.
 *
 * The model streams the JSON a token at a time. This scanner holds a stack
 * of places ("frames") - the root object, an array, an inner object - and
 * classifies every string value it meets by where it sits in that stack:
 *
 * - the string under the top-level `summary` key streams as `summary` deltas;
 * - the `text` of an object inside the `bullets` array streams as
 *   `bullet-delta` deltas, and the object announces itself again when the
 *   `evidenceIds` array that follows it closes;
 * - every string of the `recommendedActions` array is announced in full once
 *   it closes;
 * - keys, evidence ids and any unexpected field are swallowed.
 *
 * Escapes are handled: a backslash at the tail of a network chunk is held
 * back until the character it introduces arrives, and `\uXXXX` waits for its
 * four hex digits before it is decoded.
 */
export function createExplanationScanner(emit: ExplanationEmitter) {
  type Frame =
    | { t: 'obj'; key: string | null; label: string; stage: 'key' | 'value' | 'comma' }
    | { t: 'arr'; label: string; stage: 'value' | 'comma'; index: number };

  const frames: Frame[] = [];

  let inString = false;
  let escape = false;
  let unicodeLeft = 0;
  let unicodeAccumulated = '';

  /** This string's decoded content, assembled character by character. */
  let stringContent = '';
  /** The not-yet-announced part of a streaming string. */
  let unannounced = '';

  /** What the current string feeds; decided when the string begins. */
  let currentTarget: 'summary' | 'bullet-text' | 'evidence' | 'action' | 'other' = 'other';
  let currentBulletIndex = -1;
  let currentActionIndex = -1;

  /** Assembled so far. */
  let summaryValue = '';
  const bullets: { text: string; evidenceIds: string[] }[] = [];
  const actions: string[] = [];

  let corrupt = false;
  const fail = (why: string): void => {
    console.warn('[scanner] corrupt:', why);
    corrupt = true;
  };

  /**
   * Classify where a string value about to begin would land.
   *
   * The frame the string belongs to - an object with its key already read,
   * or an array element - decides. Only for our own schema: from the framer
   * side, JSON decoder behavior isn't a new format.
   */
  const classifyStringValue = (): 'summary' | 'bullet-text' | 'evidence' | 'action' | 'other' => {
    const top = frames[frames.length - 1];
    if (!top) return 'other';

    if (top.t === 'obj' && top.stage === 'value') {
      if (top.key === 'summary') {
        const parent = frames[frames.length - 2];
        // `summary` at the root is the explanation's summary; the same key
        // nested anywhere else is not.
        if (!parent) return 'summary';
        return 'other';
      }

      if (top.key === 'text') {
        const parent = frames[frames.length - 2];
        if (parent?.t === 'arr' && parent.label === 'bullets') {
          currentBulletIndex = parent.index;
          return 'bullet-text';
        }
      }

      return 'other';
    }

    if (top.t === 'obj' && top.stage === 'key') {
      // The string is a key; whatever value follows is reclassified then.
      return 'other';
    }

    if (top.t === 'arr' && top.stage === 'value') {
      if (top.label === 'recommendedActions') {
        currentActionIndex = top.index;
        return 'action';
      }
      if (top.label === 'evidenceIds') return 'evidence';
      return 'other';
    }

    return 'other';
  };

  const announce = () => {
    if (unannounced.length === 0) return;
    const text = unannounced;
    unannounced = '';

    if (currentTarget === 'summary') {
      summaryValue += text;
      emit({ type: 'summary', text });
    } else if (currentTarget === 'bullet-text') {
      const bullet = bullets[currentBulletIndex];
      if (bullet) {
        bullet.text += text;
        emit({ type: 'bullet-delta', index: currentBulletIndex, text });
      }
    } else if (currentTarget === 'action' && currentActionIndex >= 0) {
      // The action is written out like the rest of the answer; the finished
      // string is announced separately, when the model closes it.
      emit({ type: 'action-delta', index: currentActionIndex, text });
    }
  };

  const closeString = () => {
    announce();

    const top = frames[frames.length - 1];
    if (top?.t === 'obj' && top.stage === 'key') {
      top.key = stringContent;
    } else if (top?.t === 'arr' && top.stage === 'value') {
      // A scalar element of the array just completed. Nested values advance
      // the index when their frame closes; scalars advance here.
      if (currentTarget === 'evidence') {
        bullets[bullets.length - 1]?.evidenceIds.push(stringContent);
      } else if (currentTarget === 'action') {
        const index = currentActionIndex;
        actions[index] = stringContent;
        emit({ type: 'action', index, text: stringContent });
      }
      top.index += 1;
      top.stage = 'value'; // stays open while more elements may follow
    } else if (currentTarget === 'action') {
      // Defensive: an action string somewhere unexpected still reaches out.
      const index = currentActionIndex;
      actions[index] = stringContent;
      emit({ type: 'action', index, text: stringContent });
    }

    stringContent = '';
  };

  /** Feed one piece of model output into the scanner. */
  const write = (piece: string): void => {
    if (corrupt) return;

    for (const ch of piece) {
      if (inString) {
        if (unicodeLeft > 0) {
          if (!/[0-9a-fA-F]/.test(ch)) {
            fail(`non-hex digit ${JSON.stringify(ch)} inside a \\u escape`); return;
          }
          unicodeAccumulated += ch;
          unicodeLeft -= 1;
          if (unicodeLeft === 0) {
            const decoded = String.fromCharCode(parseInt(unicodeAccumulated, 16));
            stringContent += decoded;
            if (
              currentTarget === 'summary' ||
              currentTarget === 'bullet-text' ||
              currentTarget === 'action'
            ) {
              unannounced += decoded;
            }
            unicodeAccumulated = '';
          }
          continue;
        }

        if (escape) {
          escape = false;
          if (ch === 'u') {
            unicodeLeft = 4;
            unicodeAccumulated = '';
            continue;
          }
          const map: Record<string, string> = {
            n: '\n',
            t: '\t',
            b: '\b',
            f: '\f',
            r: '\r',
            '\\': '\\',
            '"': '"',
            '/': '/',
          };
          if (!(ch in map)) {
            fail(`unknown escape \\${ch}`); return;
          }
          stringContent += map[ch];
          if (
            currentTarget === 'summary' ||
            currentTarget === 'bullet-text' ||
            currentTarget === 'action'
          ) {
            unannounced += map[ch];
          }
          continue;
        }

        if (ch === '\\') {
          escape = true;
          continue;
        }

        if (ch === '"') {
          inString = false;
          closeString();
          continue;
        }

        stringContent += ch;
        if (
          currentTarget === 'summary' ||
          currentTarget === 'bullet-text' ||
          currentTarget === 'action'
        ) {
          unannounced += ch;
        }
        continue;
      }

      if (/\s/.test(ch)) continue;

      if (ch === '"') {
        inString = true;
        stringContent = '';
        unannounced = '';
        currentTarget = classifyStringValue();
        continue;
      }

      if (ch === '{' || ch === '[') {
        const top = frames[frames.length - 1];
        const parentKey: string = !top
          ? ''
          : top.t === 'obj'
            ? (top.key ?? '')
            : top.label;

        // No shape guard here on purpose: an array where an object belongs
        // (or vice versa) either parses into something validation can judge,
        // or it closes without custody - nothing worse than a dropped claim.

        if (ch === '{') {
          frames.push({ t: 'obj', key: null, label: parentKey, stage: 'key' });
          if (parentKey === 'bullets') {
            bullets.push({ text: '', evidenceIds: [] });
          }
        } else {
          frames.push({ t: 'arr', label: parentKey, stage: 'value', index: 0 });
        }
        continue;
      }

      if (ch === '}' || ch === ']') {
        const frame = frames.pop();
        if (!frame) {
          fail('closing bracket with no open frame'); return;
        }

        // A bullet's ids have just been read: announce the finished bullet.
        if (frame.t === 'arr' && frame.label === 'evidenceIds') {
          const bulletFrame = frames[frames.length - 1];
          if (bulletFrame?.t === 'obj' && bulletFrame.label === 'bullets') {
            const bullet = bullets[bullets.length - 1];
            if (bullet) {
              emit({
                type: 'bullet',
                index: bullets.length - 1,
                text: bullet.text,
                evidenceIds: bullet.evidenceIds,
              });
            }
          }
        }

        const top = frames[frames.length - 1];
        if (top?.t === 'obj') top.stage = 'comma';
        else if (top?.t === 'arr') top.index += 1;
        continue;
      }

      if (ch === ',') {
        const top = frames[frames.length - 1];
        if (top?.t === 'obj') top.stage = 'key';
        else if (top?.t === 'arr') top.stage = 'value';
        continue;
      }

      if (ch === ':') {
        const top = frames[frames.length - 1];
        if (top?.t === 'obj') top.stage = 'value';
        continue;
      }

      // Bare literals (true/false/null/numbers) are not part of this schema,
      // but swallowing them keeps a well-meant model answer joinable.
      if (/[a-z0-9-]/i.test(ch)) {
        continue;
      }

      fail(`unexpected character ${JSON.stringify(ch)} outside strings`); return;
    }

    announce();
  };

  /** The assembled object once the stream and the root object have closed. */
  const result = (): Explanation | null => {
    if (corrupt || frames.length !== 0 || inString || escape) return null;
    return { summary: summaryValue, bullets: [...bullets], recommendedActions: [...actions] };
  };

  /** Why `result` is null: the reader state. */
  const status = (): { corrupt: boolean; openFrames: number; inString: boolean } => ({
    corrupt,
    openFrames: frames.length,
    inString,
  });

  return { write, result, status };
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

async function streamGemini(
  evidence: Evidence[],
  verdict: string,
  score: number,
  emit: ExplanationEmitter,
): Promise<{ explanation: Explanation; model: string } | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: [{ role: 'user', parts: [{ text: buildPrompt(evidence, verdict, score) }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 900,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  });

  if (!response.ok) {
    console.warn('[explain] model request failed:', response.status);
    return null;
  }

  const body = await response.json();
  const raw = body?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? '').join('');

  if (!raw) return null;

  try {
    const explanation = JSON.parse(raw) as Explanation;
    replayExplanation(explanation, emit);
    return { explanation, model };
  } catch {
    console.warn('[explain] model returned invalid JSON');
    return null;
  }
}

/**
 * Repair an answer that stopped mid-write.
 *
 * A stream that ends inside the object - a dropped connection, a token limit -
 * leaves the reader with announced text and no verdict for it, which is the
 * one error a verdict card should never have to show. This keeps what was
 * already written: the raw output is cut at the last point where the JSON
 * still holds together, the containers that were still open are closed, and
 * the result must first pass the same shape check the complete object faces.
 *
 * A summary cut mid-sentence is kept - that matches pretty closely what the
 * reader already saw stream past. A bullet whose citation list never arrived
 * loses its citation and is pruned by validation, as any uncited claim would
 * be. An action cut mid-word is dropped by validation too, because actions
 * must come verbatim from the closed catalogue.
 */
export function salvageExplanation(raw: string): Explanation | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  const text = raw.slice(start);

  /* One pass: follow the structure, remember the last point where the prefix
     ended on a complete token, and what was still open there. */
  const open: string[] = [];
  let inString = false;
  let escape = false;
  let lastStable = -1; // index after the last complete structural token
  let lastStableSuffix = '';

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
        lastStable = index + 1;
        lastStableSuffix = [...open].reverse().join('');
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      open.push('}');
    } else if (ch === '[') {
      open.push(']');
    } else if (ch === '}' || ch === ']') {
      const expected = ch === '}' ? '}' : ']';
      if (open[open.length - 1] !== expected) return null;
      open.pop();
      lastStable = index + 1;
      lastStableSuffix = [...open].reverse().join('');
    }
    // Commas, colons and stray literals live inside a stable prefix; the cut
    // before them drops them along with whatever followed.
  }

  if (lastStable === -1) return null;

  /** A truncated object is only worth keeping when it is really the object. */
  const parse = (candidate: string): Explanation | null => {
    try {
      const value = JSON.parse(candidate) as {
        summary?: unknown;
        bullets?: unknown;
        recommendedActions?: unknown;
      };
      if (typeof value.summary !== 'string' || value.summary.trim().length === 0) return null;

      const bullets = Array.isArray(value.bullets)
        ? value.bullets
            .filter(
              (bullet): bullet is { text: unknown; evidenceIds?: unknown } =>
                typeof bullet === 'object' &&
                bullet !== null &&
                typeof (bullet as { text?: unknown }).text === 'string',
            )
            .map((bullet) => ({
              text: bullet.text as string,
              evidenceIds: Array.isArray(bullet.evidenceIds)
                ? bullet.evidenceIds.filter((id): id is string => typeof id === 'string')
                : [],
            }))
        : [];

      const recommendedActions = Array.isArray(value.recommendedActions)
        ? value.recommendedActions.filter((action): action is string => typeof action === 'string')
        : [];

      return { summary: value.summary, bullets, recommendedActions };
    } catch {
      return null;
    }
  };

  /* As-is first: an answer followed by stray prose still contains the whole
     object, and one parse attempt costs nothing. */
  const asComplete = parse(text);
  if (asComplete) return asComplete;

  /* Cut mid-string: the content up to the cut is a complete-enough string,
     and closing the quote stands in for the continuation the stream never
     wrote. An escape cut in half - a lone backslash, a `\u` without its hex
     digits - is dropped along with the ambiguity it introduced. */
  const candidates: string[] = [];
  if (inString) {
    let stringTail = text;
    if (stringTail.endsWith('\\')) {
      stringTail = stringTail.slice(0, -1);
    } else {
      const partialUnicode = /\\u([0-9a-fA-F]{0,4})$/.exec(stringTail);
      if (partialUnicode && partialUnicode[1].length < 4) {
        stringTail = stringTail.slice(0, stringTail.length - partialUnicode[0].length);
      }
    }
    candidates.push(stringTail + '"' + [...open].reverse().join(''));
  }

  /* Cut mid-structure: discard the partial token and close what remains. */
  candidates.push(text.slice(0, lastStable) + lastStableSuffix);

  for (const candidate of candidates) {
    const explanation = parse(candidate);
    if (explanation) return explanation;
  }

  return null;
}

/**
 * Generate the explanation with an OpenCode Go model, streamed.
 *
 * The endpoint serves an OpenAI-compatible chat completions API, so the
 * answer arrives as server-sent `data:` frames whose `delta.content` pieces
 * go into the scanner. Requirements that are easy to get wrong:
 *
 * - every request must carry a stable `x-opencode-session` header, without
 *   it the service refuses with `MissingSessionID`;
 * - the client identifies itself with its own user agent, the traffic being
 *   routed and monitored on that basis;
 * - the strict JSON schema is still requested with the stream, but its hold
 *   is not guaranteed - a model that answers in prose simply fails to parse
 *   into the object, and the chain moves to the next candidate.
 */
async function streamOpenCode(
  evidence: Evidence[],
  verdict: string,
  score: number,
  model: string,
  emit: ExplanationEmitter,
): Promise<{ explanation: Explanation; model: string } | null> {
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey) return null;

  const baseUrl = (process.env.OPENCODE_BASE_URL ?? DEFAULT_OPENCODE_BASE_URL).replace(/\/+$/, '');

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'x-opencode-session': process.env.OPENCODE_SESSION_ID ?? OPENCODE_SESSION_ID,
      'User-Agent': 'invisiphish/0.2.0',
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_INSTRUCTION },
        { role: 'user', content: buildPrompt(evidence, verdict, score) },
      ],
      temperature: 0,
      max_tokens: 2000,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'explanation',
          strict: true,
          schema: RESPONSE_SCHEMA,
        },
      },
    }),
  });

  if (!response.ok || !response.body) {
    console.warn(`[explain] ${model} refused the request:`, response.status);
    return null;
  }

  const scanner = createExplanationScanner(emit);
  const rawPieces: string[] = [];

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let finished = false;

  const consumeSseFrame = (frame: string) => {
    for (const line of frame.split('\n')) {
      const content = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!content || content === '[DONE]') continue;
      try {
        const parsed = JSON.parse(content) as { choices?: { delta?: { content?: string } }[] };
        const piece = parsed.choices?.[0]?.delta?.content;
        if (typeof piece === 'string' && piece.length > 0) {
          rawPieces.push(piece);
          scanner.write(piece);
        }
      } catch {
        // Frames that do not parse carry no content; ignore them.
      }
    }
  };

  while (!finished) {
    const read = await reader.read();
    finished = read.done;
    if (read.value) {
      sseBuffer += decoder.decode(read.value, { stream: true });

      let separator = sseBuffer.indexOf('\n\n');
      while (separator !== -1) {
        consumeSseFrame(sseBuffer.slice(0, separator));
        sseBuffer = sseBuffer.slice(separator + 2);
        separator = sseBuffer.indexOf('\n\n');
      }
    }
  }
  if (sseBuffer.trim().length > 0) consumeSseFrame(sseBuffer);

  const explanation = scanner.result();
  if (!explanation) {
    // The stream stopped before the object closed - a dropped connection or a
    // token limit, most often. What survived the cut is still worth keeping.
    const salvaged = salvageExplanation(rawPieces.join(''));
    if (salvaged) {
      console.warn(
        `[explain] ${model} stopped mid-write; salvaged ${
          salvaged.bullets.length
        } bullets and ${salvaged.recommendedActions.length} actions from ${rawPieces.join('').length} characters`,
      );
      return { explanation: salvaged, model };
    }

    console.warn(
      `[explain] ${model} streamed an answer that could not be read as the object;`,
      `state=${JSON.stringify(scanner.status())}, sseBuffer=${JSON.stringify(sseBuffer.slice(-120))}, rawLen=${rawPieces.join('').length}`,
      `rawTail=${JSON.stringify(rawPieces.join('').slice(-300))}`,
    );
    return null;
  }

  return { explanation, model };
}

/* ------------------------------------------------------------------ */
/* The chain, the validation                                           */
/* ------------------------------------------------------------------ */

/**
 * Generate the explanation with the first model that answers, streamed.
 *
 * Models are tried in order. A model is unusable when the service refuses
 * the request, when its stream cannot be read as the object, or when the
 * answer does not survive validation. Once a reader-visible piece has made
 * it out, the chain stops instead of switching midway: retracting visible
 * text is worse than reporting the failure.
 */
async function streamWithFallback(
  evidence: Evidence[],
  verdict: string,
  score: number,
  emit: ExplanationEmitter,
): Promise<{ explanation: Explanation; model: string } | null> {
  const models = openCodeModels();

  for (const model of models) {
    const started = Date.now();
    let visible = false;
    const watching: ExplanationEmitter = (event) => {
      if (isReaderVisible(event)) visible = true;
      emit(event);
    };

    const outcome = await streamOpenCode(evidence, verdict, score, model, watching).catch(
      (error: unknown) => {
        console.warn(
          `[explain] ${model} stream failed:`,
          error instanceof Error ? error.message : error,
        );
        return null;
      },
    );

    if (outcome) {
      console.log(`[explain] answered by ${model} in ${Date.now() - started} ms`);
      return outcome;
    }

    if (visible) break; // text is already on the reader's screen
  }

  console.warn(`[explain] none of the ${models.length} models answered`);
  return null;
}

/**
 * Generate an explanation and validate that it is grounded in the evidence.
 *
 * While a model streams, everything arriving is announced immediately; the
 * `done` event rides last. When the chain produced nothing and nothing was
 * announced, the deterministic mock is replayed so the card still fills.
 * When text was already announced and the object then failed to verify, an
 * error is thrown and the caller is expected to report it - there is no
 * honest way to substitute a different voice mid-sentence.
 */
export async function explainFromEvidence(
  evidence: Evidence[],
  verdict: string,
  score: number,
  emit?: ExplanationEmitter,
): Promise<ExplainOutcome> {
  const provider = (process.env.EXPLAIN_PROVIDER ?? 'opencode').toLowerCase();
  const sink: ExplanationEmitter = emit ?? (() => undefined);
  let announced = false;
  const watching: ExplanationEmitter = (event) => {
    if (isReaderVisible(event)) announced = true;
    sink(event);
  };

  const generated =
    provider === 'gemini'
      ? await streamGemini(evidence, verdict, score, watching)
      : await streamWithFallback(evidence, verdict, score, watching);

  if (!generated) {
    if (announced) {
      throw new Error('The model answer could not be verified.');
    }

    const candidate = mockExplanation(evidence, verdict, score);
    const { explanation, report } = validateExplanation(candidate, evidence, {
      catalogue: RECOMMENDED_ACTIONS,
      minGroundedness: 0.5,
    });

    replayExplanation(explanation, sink);
    const outcome: ExplainOutcome = { explanation, groundedness: report, generated: false };
    sink({ type: 'done', explanation, groundedness: report, removedBulletIndexes: [], generated: false });
    return outcome;
  }

  const { explanation, report } = validateExplanation(generated.explanation, evidence, {
    catalogue: RECOMMENDED_ACTIONS,
    minGroundedness: 0.5,
  });

  // Which streamed bullets the validation dropped: the final list is a
  // subsequence of the streamed one, so a pointer walk maps the survivors.
  const removedBulletIndexes: number[] = [];
  let cursor = 0;
  const streamed = generated.explanation.bullets ?? [];
  for (let index = 0; index < streamed.length; index += 1) {
    if (
      cursor < explanation.bullets.length &&
      explanation.bullets[cursor].text === streamed[index].text
    ) {
      cursor += 1;
    } else {
      removedBulletIndexes.push(index);
    }
  }

  const outcome: ExplainOutcome = {
    explanation,
    groundedness: report,
    generated: true,
    model: generated.model,
  };

  sink({
    type: 'done',
    explanation,
    groundedness: report,
    removedBulletIndexes,
    generated: true,
    model: generated.model,
  });

  return outcome;
}
