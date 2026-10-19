/**
 * Jev gate core.
 *
 * A gate is a small decision authority for AI-agent actions: deterministic
 * rules run first (first hit decides, the judge is never called), an optional
 * AI judge covers the grey zone, and everything uncertain is deferred to a
 * human. The core never guesses and never fails open: malformed judge output,
 * abstentions, low-confidence verdicts and irreversible actions all end in
 * `human`.
 */

/** Confidence a judge verdict needs before the gate acts on it (0..1). */
export const DEFAULT_THRESHOLD = 0.7;

export type GateOutcome = 'allow' | 'block' | 'human';
export type DecisionSource = 'rule' | 'judge' | 'human' | 'none';
export type RuleOutcome = 'allow' | 'block';
export type JudgeVerdictName = 'allow' | 'block' | 'abstain';

/** Pipeline stage a {@link DecisionLogEntry} belongs to. */
export type DecisionStage =
  | 'rule'
  | 'judge'
  | 'irreversible'
  | 'fallback'
  | 'decision';

/** The action an agent wants to perform, as seen by rules and the judge. */
export interface GateInput {
  action: string;
  irreversible?: boolean;
  context?: Record<string, unknown>;
  diff?: string;
  files?: string[];
}

/** Deterministic result of a rule that matched the input. */
export interface RuleHit {
  outcome: RuleOutcome;
  reason: string;
  evidence?: string;
}

/**
 * Deterministic, ordered check. The first rule that returns a hit decides the
 * outcome; `null` means "no opinion, keep going".
 */
export interface Rule {
  id: string;
  evaluate(input: GateInput): RuleHit | null;
}

/** Strict shape a judge must produce for the core to accept its verdict. */
export interface JudgeVerdict {
  verdict: JudgeVerdictName;
  /** Confidence in the verdict, 0..1 inclusive. */
  score: number;
  /** Non-empty human-readable justification. */
  evidence: string;
}

/**
 * Anything that can score a grey-zone input. Judges return raw `unknown` —
 * the core validates strictly and treats anything malformed as uncertain.
 */
export interface Judge {
  judge(input: GateInput): Promise<unknown>;
}

/** Structured audit entry appended to every {@link Decision}. */
export interface DecisionLogEntry {
  /** ISO-8601 timestamp. */
  ts: string;
  /** Pipeline stage the entry belongs to. */
  stage: DecisionStage;
  /** Human-readable detail. */
  detail: string;
}

/** Final gate decision for one input. */
export interface Decision {
  outcome: GateOutcome;
  /**
   * Which authority produced the outcome:
   * - `rule`: a caller rule hit (allow/block).
   * - `judge`: a valid judge allow/block at or above threshold.
   * - `human`: the gate deferred to a human (abstain, below threshold,
   *   invalid judge output, or irreversible + judge allow).
   * - `none`: no rule hit and no judge configured.
   */
  source: DecisionSource;
  ruleId?: string;
  judgeVerdict?: JudgeVerdict;
  reason: string;
  log: DecisionLogEntry[];
}

/** Context handed to {@link GateOptions.onUncertain} when deferring to a human. */
export interface UncertainInfo {
  input: GateInput;
  reason: string;
  judgeVerdict?: JudgeVerdict;
  log: DecisionLogEntry[];
}

export interface GateOptions {
  rules?: Rule[];
  judge?: Judge;
  /** Called whenever the gate defers to a human. Errors are logged, never thrown. */
  onUncertain?: (info: UncertainInfo) => void | Promise<void>;
  /** Minimum judge score to act on allow/block verdicts. Default 0.7. */
  threshold?: number;
}

export interface Gate {
  decide(input: GateInput): Promise<Decision>;
}

/** Result of strict judge-output validation. */
export type ParsedJudgeVerdict =
  | { ok: true; value: JudgeVerdict }
  | { ok: false; error: string };

const GENERIC_VERDICTS: readonly string[] = ['allow', 'block', 'abstain'];

/**
 * Validate a raw judge response strictly, without coercion.
 *
 * Required: a `verdict` string contained in `allowedVerdicts`, a finite
 * `score` in [0, 1], and a non-empty `evidence` string. Extra object keys are
 * tolerated; everything else (missing fields, wrong types, out-of-range
 * scores, unknown verdicts, non-objects) is rejected so the gate can defer to
 * a human instead of guessing.
 *
 * `allowedVerdicts` defaults to the generic `allow | block | abstain` set and
 * exists as the extension point for caller-provided verdict enums; any
 * allowed verdict other than `allow`/`block` behaves like `abstain`.
 */
export function parseJudgeVerdict(
  raw: unknown,
  allowedVerdicts: readonly string[] = GENERIC_VERDICTS,
): ParsedJudgeVerdict {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'not an object' };
  }
  const record = raw as Record<string, unknown>;

  const { verdict } = record;
  if (
    typeof verdict !== 'string' ||
    !allowedVerdicts.includes(verdict)
  ) {
    return {
      ok: false,
      error: `verdict must be one of [${allowedVerdicts.join('|')}]`,
    };
  }

  const { score } = record;
  if (
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 1
  ) {
    return { ok: false, error: 'score must be a finite number in [0, 1]' };
  }

  const { evidence } = record;
  if (typeof evidence !== 'string' || evidence.trim() === '') {
    return { ok: false, error: 'evidence must be a non-empty string' };
  }

  return { ok: true, value: { verdict: verdict as JudgeVerdictName, score, evidence } };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function oneLine(text: string, max: number): string {
  const squashed = text.replace(/\s+/g, ' ').trim();
  return squashed.length <= max ? squashed : `${squashed.slice(0, max)}…`;
}

function isValidHit(hit: unknown): hit is RuleHit {
  if (typeof hit !== 'object' || hit === null) return false;
  const candidate = hit as Record<string, unknown>;
  return (
    (candidate.outcome === 'allow' || candidate.outcome === 'block') &&
    typeof candidate.reason === 'string' &&
    candidate.reason.trim() !== ''
  );
}

/**
 * Create a gate: deterministic rules first, an optional judge for the grey
 * zone, humans for everything uncertain.
 *
 * Configuration errors (bad threshold, malformed rules/judge) throw at
 * definition time — they are programmer errors. `decide()` itself never
 * throws: a throwing rule is treated as a miss, a throwing judge is treated
 * as uncertain, and every uncertain path defers to `human`.
 *
 * Irreversibility: when `input.irreversible === true`, a judge `allow` can
 * never approve the action alone — the decision becomes `human` regardless of
 * score. A judge `block` still blocks (blocking is the safe direction), and
 * caller rules remain authoritative for their own allow/block hits.
 */
export function defineGate(options: GateOptions): Gate {
  const opts = options ?? {};

  if (
    opts.threshold !== undefined &&
    (typeof opts.threshold !== 'number' ||
      !Number.isFinite(opts.threshold) ||
      opts.threshold < 0 ||
      opts.threshold > 1)
  ) {
    throw new RangeError('defineGate: threshold must be a finite number in [0, 1]');
  }
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

  const rules = Array.isArray(opts.rules) ? opts.rules : [];
  rules.forEach((rule, index) => {
    if (
      !rule ||
      typeof rule !== 'object' ||
      typeof rule.id !== 'string' ||
      rule.id.trim() === '' ||
      typeof rule.evaluate !== 'function'
    ) {
      throw new TypeError(`defineGate: rules[${index}] must be { id: string, evaluate(input) }`);
    }
  });

  const judge = opts.judge;
  if (judge !== undefined && (judge === null || typeof judge.judge !== 'function')) {
    throw new TypeError('defineGate: judge must implement judge(input)');
  }

  const onUncertain = opts.onUncertain;
  if (onUncertain !== undefined && typeof onUncertain !== 'function') {
    throw new TypeError('defineGate: onUncertain must be a function');
  }

  return { decide: (input) => runGate(input, { rules, judge, onUncertain, threshold }) };
}

interface GateRuntime {
  rules: Rule[];
  judge?: Judge;
  onUncertain?: (info: UncertainInfo) => void | Promise<void>;
  threshold: number;
}

async function runGate(input: GateInput, config: GateRuntime): Promise<Decision> {
  const { rules, judge, onUncertain, threshold } = config;
  const log: DecisionLogEntry[] = [];
  const entry = (stage: DecisionStage, detail: string): void => {
    log.push({ ts: new Date().toISOString(), stage, detail });
  };

  const toHuman = async (
    source: DecisionSource,
    reason: string,
    judgeVerdict?: JudgeVerdict,
  ): Promise<Decision> => {
    entry('decision', `outcome=human source=${source}`);
    const decision: Decision = {
      outcome: 'human',
      source,
      reason,
      judgeVerdict,
      log,
    };
    if (onUncertain) {
      try {
        await onUncertain({ input, reason, judgeVerdict, log: [...log] });
      } catch (err) {
        entry('fallback', `onUncertain callback failed: ${errMessage(err)}`);
      }
    }
    return decision;
  };

  if (
    input === null ||
    typeof input !== 'object' ||
    typeof input.action !== 'string' ||
    input.action.trim() === ''
  ) {
    return toHuman('none', 'invalid gate input: action must be a non-empty string');
  }

  for (const rule of rules) {
    let hit: unknown;
    try {
      hit = rule.evaluate(input);
    } catch (err) {
      entry('rule', `rule "${rule.id}" threw: ${errMessage(err)}; treated as miss`);
      continue;
    }
    if (isValidHit(hit)) {
      entry('rule', `rule "${rule.id}" hit: ${hit.outcome} — ${oneLine(hit.reason, 200)}`);
      entry('decision', `outcome=${hit.outcome} source=rule rule="${rule.id}"`);
      return {
        outcome: hit.outcome,
        source: 'rule',
        ruleId: rule.id,
        reason: hit.reason,
        log,
      };
    }
    entry('rule', `rule "${rule.id}" miss${hit === null ? '' : ' (invalid hit treated as miss)'}`);
  }
  entry('rule', `no rule hit (${rules.length} evaluated): grey zone`);

  if (!judge) {
    entry('fallback', 'no judge configured: deferring to human');
    return toHuman('none', 'no rule hit and no judge configured: human decision required');
  }

  entry('judge', 'grey zone: consulting judge');
  let raw: unknown;
  try {
    raw = await judge.judge(input);
  } catch (err) {
    entry('judge', `judge threw: ${errMessage(err)}; deferring to human`);
    return toHuman('human', `judge failed: ${errMessage(err)}; human decision required`);
  }

  const parsed = parseJudgeVerdict(raw);
  if (!parsed.ok) {
    entry('judge', `invalid judge output (${parsed.error}); deferring to human — never guess`);
    return toHuman('human', `judge output invalid: ${parsed.error}; human decision required`);
  }
  const verdict = parsed.value;
  entry('judge', `verdict=${verdict.verdict} score=${verdict.score} evidence="${oneLine(verdict.evidence, 200)}"`);

  if (input.irreversible === true && verdict.verdict === 'allow') {
    entry('irreversible', 'input.irreversible=true: a judge allow can never approve alone; human required');
    return toHuman(
      'human',
      'irreversible action: judge allow cannot approve without a human',
      verdict,
    );
  }

  if (verdict.verdict === 'abstain') {
    entry('judge', 'judge abstained: deferring to human');
    return toHuman('human', `judge abstained: ${verdict.evidence}`, verdict);
  }

  if (verdict.score < threshold) {
    entry('judge', `score ${verdict.score} below threshold ${threshold}: deferring to human`);
    return toHuman(
      'human',
      `judge ${verdict.verdict} confidence ${verdict.score} below threshold ${threshold}`,
      verdict,
    );
  }

  entry('decision', `outcome=${verdict.verdict} source=judge score=${verdict.score}`);
  return {
    outcome: verdict.verdict,
    source: 'judge',
    judgeVerdict: verdict,
    reason: verdict.evidence,
    log,
  };
}
