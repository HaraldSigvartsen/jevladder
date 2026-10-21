/**
 * Deterministic task router.
 *
 * `scoreRoute` scores a task description on three axes — difficulty,
 * consequence, verifiability — using keyword signals only: no model calls,
 * no randomness, no time dependence. The same input always produces the
 * exact same output.
 *
 * Composite score: `0.6·difficulty + 0.4·consequence` (verifiability is
 * reported for consumers but does not lower the score — an easily verified
 * task is not a less difficult one).
 *
 * Tiers:
 * - `cheap`: score < 0.35 AND consequence < 0.6
 * - `frontier`: score >= 0.65 OR consequence >= 0.85
 * - `mid`: everything else
 *
 * Low confidence (very short or ambiguous-without-specifics input) moves the
 * tier one step UP (cheap→mid, mid→frontier) and sets `abstained: true`:
 * when in doubt, buy the stronger model and flag the uncertainty.
 *
 * Empty or whitespace-only input is not a task. `scoreRoute` rejects it
 * instead of selecting a tier.
 */
export type RouteTier = 'cheap' | 'mid' | 'frontier';
export type RouteAxisName = 'difficulty' | 'consequence' | 'verifiability';

export interface RouteSignal {
  signal: string;
  /** Contribution to its axis, 0..1 (axes clamp at 1). */
  weight: number;
  detail: string;
}

export interface RouteAxes {
  difficulty: number;
  consequence: number;
  verifiability: number;
}

export interface RouteResult {
  rejected: false;
  tier: RouteTier;
  axes: RouteAxes;
  /** Fired signals, top 5 by weight (ties keep firing order). */
  signals: RouteSignal[];
  /** True when low confidence raised the tier. */
  abstained: boolean;
  explanation: string;
}

/** Empty or whitespace-only input: there is no task to classify. */
export interface RouteRejection {
  rejected: true;
  reason: string;
}

export type RouteDecision = RouteResult | RouteRejection;

export const SCORE_DIFFICULTY_SHARE = 0.6;
export const SCORE_CONSEQUENCE_SHARE = 0.4;

export const CHEAP_MAX_SCORE = 0.35;
export const CHEAP_MAX_CONSEQUENCE = 0.6;
export const FRONTIER_MIN_SCORE = 0.65;
export const FRONTIER_MIN_CONSEQUENCE = 0.85;

const MAX_SIGNALS = 5;
const MIN_WORDS = 4;
const MIN_CHARS = 16;

const WEIGHT_DOMAIN = 0.25;
const WEIGHT_CROSS_DOMAIN = 0.55;
const WEIGHT_MULTI_FILE = 0.35;
const WEIGHT_AMBIGUOUS = 0.3;

const DOMAINS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'db', re: /\b(?:db|database|sql|schema|migrat\w*|tables?|indexes?)\b/i },
  { name: 'api', re: /\b(?:api|endpoints?|routes?|handlers?|rest|graphql)\b/i },
  {
    name: 'frontend',
    re: /\b(?:ui|ux|frontend|components?|css|styles?|render|buttons?|forms?|layouts?|menus?|modals?)\b/i,
  },
  {
    name: 'auth',
    re: /\b(?:auth\w*|logins?|logouts?|sessions?|tokens?|passwords?|oauth|jwt)\b/i,
  },
  {
    name: 'payment',
    re: /\b(?:payments?|billing|charges?|refunds?|invoices?|subscriptions?|checkout)\b/i,
  },
];

interface WeightedSignal {
  signal: string;
  weight: number;
  re: RegExp;
  detail: string;
}

const CONSEQUENCE_SIGNALS: readonly WeightedSignal[] = [
  {
    signal: 'money',
    weight: 0.65,
    re: /\b(?:payments?|billing|charges?|refunds?|invoices?|subscriptions?|checkout)\b/i,
    detail: 'money/billing surface',
  },
  {
    signal: 'deploy/production',
    weight: 0.7,
    re: /\b(?:deploys?|deployments?|releases?|publish|production|prod)\b/i,
    detail: 'deployment or production surface',
  },
  {
    signal: 'destructive',
    weight: 0.6,
    re: /\b(?:delet\w+|drops?|dropped|truncate|wip(?:e|ed)|destructive)\b/i,
    detail: 'can destroy data',
  },
  {
    signal: 'migration/irreversible',
    weight: 0.5,
    re: /\b(?:migrat\w+|irreversible|one-?way)\b/i,
    detail: 'migration or irreversible change',
  },
];

const VERIFIABILITY_SIGNALS: readonly WeightedSignal[] = [
  {
    signal: 'tests-referenced',
    weight: 0.3,
    re: /\b(?:tests?|specs?|unit[\s-]?tests?|coverage)\b/i,
    detail: 'tests referenced',
  },
  {
    signal: 'test-file',
    weight: 0.2,
    re: /(?:\.test\.[a-z]+|\.spec\.[a-z]+|(?:^|\/)tests?\/)/i,
    detail: 'test file path given',
  },
  {
    signal: 'error-symptom',
    weight: 0.2,
    re: /\b(?:errors?|exception|traceback|stack[\s-]?trace|fails?|failing|failed|crash\w*)\b/i,
    detail: 'error symptom described',
  },
  {
    signal: 'repro',
    weight: 0.2,
    re: /\b(?:repro\w*|steps?\s+to\s+reproduce|expected\s+vs\.?\s+actual)\b/i,
    detail: 'reproduction provided',
  },
];

const PATH_LIKE_RE =
  /(?:[\w.@-]+\/)+[\w.@-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|cts|mts|py|go|rs|java|rb|php|cs|css|scss|less|html?|sql|json|ya?ml|toml|ini|sh|bash|zsh|tf|proto|md|markdown)\b/g;
const MULTI_FILE_PHRASE_RE =
  /\b(?:multiple|several|many)\s+files?\b|\bacross\s+(?:the\s+)?files\b/i;
const AMBIGUOUS_WORDS_RE =
  /\b(?:fix(?:es|ed)?|improv\w+|somehow|refactor\w*|tweak\w*|clean\s?up|cleanup|optimiz\w+|make\s+it\s+better)\b/i;
const QUOTED_SNIPPET_RE = /(['"`])[^'"`\n]{3,}\1/;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Score a task string deterministically; throws only on non-string input. */
export function scoreRoute(task: string): RouteDecision {
  if (typeof task !== 'string') {
    throw new TypeError('scoreRoute: task must be a string');
  }
  const text = task.trim();
  if (text.length === 0) {
    return { rejected: true, reason: 'route task is empty' };
  }
  const words = text.length === 0 ? [] : text.split(/\s+/);

  const signals: RouteSignal[] = [];
  const axes: RouteAxes = { difficulty: 0, consequence: 0, verifiability: 0 };
  const fired = new Set<string>();

  const addSignal = (
    axis: RouteAxisName,
    signal: string,
    weight: number,
    detail: string,
  ): void => {
    fired.add(signal);
    axes[axis] = clamp01(axes[axis] + weight);
    signals.push({ signal, weight, detail });
  };

  for (const def of CONSEQUENCE_SIGNALS) {
    const match = text.match(def.re);
    if (match) {
      addSignal('consequence', def.signal, def.weight, `${def.detail} ("${match[0].toLowerCase()}")`);
    }
  }

  for (const def of VERIFIABILITY_SIGNALS) {
    const match = text.match(def.re);
    if (match) {
      addSignal('verifiability', def.signal, def.weight, `${def.detail} ("${match[0].toLowerCase()}")`);
    }
  }

  const matchedDomains = DOMAINS.filter((d) => d.re.test(text)).map((d) => d.name);
  if (matchedDomains.length >= 2) {
    addSignal('difficulty', 'cross-domain', WEIGHT_CROSS_DOMAIN, `spans ${matchedDomains.join(' + ')}`);
  } else if (matchedDomains.length === 1) {
    addSignal(
      'difficulty',
      `domain:${matchedDomains[0]}`,
      WEIGHT_DOMAIN,
      `touches the ${matchedDomains[0]} boundary`,
    );
  }

  const paths = text.match(PATH_LIKE_RE) ?? [];
  const distinctPaths = [...new Set(paths.map((p) => p.toLowerCase()))];
  if (distinctPaths.length >= 2) {
    addSignal('difficulty', 'multi-file', WEIGHT_MULTI_FILE, `names ${distinctPaths.length} distinct paths`);
  } else if (MULTI_FILE_PHRASE_RE.test(text)) {
    addSignal('difficulty', 'multi-file', WEIGHT_MULTI_FILE, 'explicitly says multiple files');
  }

  const ambiguous = AMBIGUOUS_WORDS_RE.exec(text);
  const hasSpecifics =
    distinctPaths.length >= 1 ||
    QUOTED_SNIPPET_RE.test(text) ||
    fired.has('tests-referenced') ||
    fired.has('test-file') ||
    fired.has('error-symptom') ||
    fired.has('repro');
  let lowConfidence = words.length < MIN_WORDS || text.length < MIN_CHARS;
  if (ambiguous && !hasSpecifics) {
    addSignal(
      'difficulty',
      'ambiguous-without-specifics',
      WEIGHT_AMBIGUOUS,
      `vague wording ("${ambiguous[0].toLowerCase()}") with no file, test, error or repro anchor`,
    );
    lowConfidence = true;
  }

  const score = round2(
    SCORE_DIFFICULTY_SHARE * axes.difficulty + SCORE_CONSEQUENCE_SHARE * axes.consequence,
  );

  let tier: RouteTier;
  if (score < CHEAP_MAX_SCORE && axes.consequence < CHEAP_MAX_CONSEQUENCE) {
    tier = 'cheap';
  } else if (score >= FRONTIER_MIN_SCORE || axes.consequence >= FRONTIER_MIN_CONSEQUENCE) {
    tier = 'frontier';
  } else {
    tier = 'mid';
  }

  let abstained = false;
  if (lowConfidence) {
    tier = tier === 'cheap' ? 'mid' : 'frontier';
    abstained = true;
  }

  const topSignals = [...signals]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_SIGNALS);

  const explanation = [
    `score=${score.toFixed(2)} (= ${SCORE_DIFFICULTY_SHARE}·difficulty + ${SCORE_CONSEQUENCE_SHARE}·consequence)`,
    `axes: difficulty=${axes.difficulty.toFixed(2)}, consequence=${axes.consequence.toFixed(2)}, verifiability=${axes.verifiability.toFixed(2)}`,
    `tier=${tier}`,
    lowConfidence
      ? 'low-confidence input: tier raised one step, abstained=true'
      : 'input specific enough: abstained=false',
    `signals: ${topSignals.map((s) => `${s.signal}(+${s.weight})`).join(', ') || 'none'}`,
  ].join(' | ');

  return { rejected: false, tier, axes, signals: topSignals, abstained, explanation };
}
