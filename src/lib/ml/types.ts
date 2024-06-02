/**
 * Core contracts for the Vigil detection pipeline.
 *
 * Design rule: every detection module communicates with the rest of the system
 * *only* through `Evidence`. The aggregation engine scores from module results,
 * and the explanation layer is only ever allowed to verbalise evidence that was
 * actually computed by the pipeline. This is what makes the paper's claim of
 * "evidence-grounded explainability" enforceable in code rather than aspirational.
 */

export type ModuleId =
  /** FP-Growth mined recurring scam templates. */
  | 'pattern'
  /** Contextual semantic classification (DistilBERT). */
  | 'semantic'
  /** Social-engineering manipulation cues: urgency, scarcity, authority, fear, reward. */
  | 'intent'
  /** URL structural heuristics. */
  | 'url-intel'
  /** Domain registration metadata (RDAP / WHOIS). */
  | 'domain-intel';

export type EvidenceKind = 'pattern' | 'semantic' | 'intent' | 'url' | 'domain' | 'lexical';

export interface Evidence {
  /** Stable identifier. The explanation layer cites these and nothing else. */
  id: string;
  kind: EvidenceKind;
  module: ModuleId;
  /** Short human-readable statement of what was detected. */
  label: string;
  /** Supporting detail (matched template, domain age, ...). */
  detail: string;
  /** How strongly this item indicates phishing, 0..1. */
  score: number;
  /** How prominent this item is within its module, 0..1. */
  severity: number;
  /** Structured extras for the UI and the audit log. */
  meta?: Record<string, unknown>;
}

export type ModuleStatus =
  /** Module ran and produced a usable score. */
  | 'ok'
  /** Module could not run (e.g. missing checkpoint). Its weight is redistributed. */
  | 'skipped'
  /** Module threw. Its weight is redistributed. */
  | 'error';

export interface ModuleResult {
  module: ModuleId;
  status: ModuleStatus;
  /** Phishing probability from this module, 0..1. */
  score: number;
  /** Confidence in this module's own score, 0..1. */
  confidence: number;
  evidence: Evidence[];
  latencyMs: number;
  /** Populated when status is 'error' or 'skipped'. */
  error?: string;
}

export type Verdict = 'legitimate' | 'suspicious' | 'phishing';

export interface ScoreContribution {
  module: ModuleId;
  /** Renormalised weight actually applied. */
  weight: number;
  /** Raw module score. */
  score: number;
  /** weight * score. */
  contribution: number;
  status: ModuleStatus;
}

export interface AggregationResult {
  finalScore: number;
  verdict: Verdict;
  /** Agreement between modules, damped by how many modules actually ran. */
  confidence: number;
  contributions: ScoreContribution[];
  /** Evidence ordered by how much it drove the final score. */
  rankedEvidence: Evidence[];
}

export interface ExplanationBullet {
  text: string;
  /** Evidence ids this claim rests on. Must be non-empty and resolvable. */
  evidenceIds: string[];
}

export interface Explanation {
  summary: string;
  bullets: ExplanationBullet[];
  recommendedActions: string[];
}

/**
 * A recommended action drawn from a closed catalogue.
 *
 * Keeping the vocabulary closed is what stops the generative layer from
 * inventing advice that no computed evidence supports.
 */
export interface AllowedAction {
  id: string;
  text: string;
  /** Evidence kinds that justify this action. */
  evidenceKinds: EvidenceKind[];
}

export interface GroundednessReport {
  /** 0..1 - fraction of bullets that cite real, computed evidence. */
  score: number;
  validBullets: number;
  invalidBullets: number;
  unknownEvidenceIds: string[];
  droppedBullets: { text: string; reason: string }[];
}

export interface AnalysisReport {
  id: string;
  finalScore: number;
  verdict: Verdict;
  confidence: number;
  modules: ModuleResult[];
  evidence: Evidence[];
  contributions: ScoreContribution[];
  explanation?: Explanation;
  groundedness?: GroundednessReport;
  createdAt: string;
  userId?: string;
  /** Version of the semantic checkpoint + pattern set used, for reproducibility. */
  modelVersion?: string;
}
