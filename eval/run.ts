#!/usr/bin/env node
/**
 * TierClef eval runner: two arms over the labelled synthetic tasks in tasks.ts.
 *
 * Arm TIERCLEF (the thing being evaluated):
 * - merge tasks: deterministic merge rules first (free, first hit decides),
 *   grey zone to a cheap mock judge that can abstain; abstentions and
 *   irreversible judge-allows defer to a human (human-review cost proxy).
 * - route tasks: deterministic scoreRoute tiers the task (cheap/mid/frontier).
 *
 * Arm ALL-FRONTIER (baseline simulation — not a real frontier judge):
 * - merge tasks: the SAME deterministic rules (kept in both arms to isolate
 *   the judge/tiering variable), but every grey-zone merge goes to a
 *   frontier-priced mock judge that confidently allows everything and never
 *   abstains. Its errors are exactly the grey tasks expected human/block
 *   that it allows.
 * - route tasks: every task runs on the frontier tier.
 *
 * Limitations (also printed in the report): the baseline's mock always allows
 * and never abstains — a real frontier model would sometimes block or
 * abstain, so quality parity here illustrates the failure mode of confident
 * permissiveness without an abstention channel, not a claim about any
 * specific model. All prices are mock constants; all tasks are synthetic
 * with fake secrets only.
 *
 * Deterministic: mock judges and keyword routing only, no network, no keys,
 * no timestamps in outputs. `npm run eval` = build + `node dist/eval/run.js`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineGate, type Decision, type Judge } from '../src/gate.js';
import { makeMergeRules } from '../src/rules/merge-rules.js';
import { MockJudge } from '../src/judge/mock.js';
import { scoreRoute, type RouteTier } from '../src/route.js';
import { evalTasks, type EvalTask, type ExpectedOutcome } from './tasks.js';

/* ------------------------------------------------------------------ *
 * Mock price model (constants, not quotes from any provider)
 * ------------------------------------------------------------------ */

export const PRICES = {
  /** Deterministic rule decisions are free. */
  ruleDecision: 0,
  cheapCall: 0.002,
  /** Mock assumption to complete the ladder (spec pins cheap+frontier only). */
  midCall: 0.01,
  frontierCall: 0.05,
  /** Human review time proxy, charged once per human outcome. */
  humanReview: 0.2,
  /** Retry/escalation overhead, charged once per human outcome. */
  escalationRetry: 0.05,
  /** Mock token estimate per model call (judge call or routed execution). */
  tokensPerCall: 400,
} as const;

export const ROUTE_TIER_PRICE: Record<RouteTier, number> = {
  cheap: PRICES.cheapCall,
  mid: PRICES.midCall,
  frontier: PRICES.frontierCall,
};

/* ------------------------------------------------------------------ *
 * Baseline judge: a frontier-priced mock that always allows
 * ------------------------------------------------------------------ */

export class PermissiveFrontierMock implements Judge {
  async judge(): Promise<unknown> {
    return {
      verdict: 'allow',
      score: 0.9,
      evidence: 'frontier-mock: no concerns (simulation — always allows, never abstains)',
    };
  }
}

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

export type Outcome = 'allow' | 'block' | 'human' | RouteTier | 'reject';

export interface ArmOutcome {
  id: string;
  kind: 'merge' | 'route';
  expected: ExpectedOutcome;
  outcome: Outcome;
  correct: boolean;
  cost: number;
  /** Judge calls (merge) or routed model executions (route). */
  modelCalls: number;
  /** True when the outcome is an explicit human deferral (merge only). */
  escalated: boolean;
  reason: string;
}

export interface EvalRun {
  tasks: readonly EvalTask[];
  tierclef: ArmOutcome[];
  baseline: ArmOutcome[];
}

export interface KnownWeaknessRecord {
  id: string;
  expected: ExpectedOutcome;
  actual: Outcome;
  fixed: boolean;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function decisionSummary(decision: Decision): string {
  return decision.source + (decision.ruleId ? ':' + decision.ruleId : '');
}

/**
 * Cost of one merge decision. Judge-consulted is detected via the audit log
 * (a 'judge' stage entry exists iff the judge was called). Rule stops are
 * automated and cost 0; only explicit human outcomes carry the human-review
 * proxy plus the escalation retry overhead.
 */
function mergeCost(
  decision: Decision,
  judgeCallPrice: number,
): { cost: number; modelCalls: number; escalated: boolean } {
  const judgeConsulted = decision.log.some((entry) => entry.stage === 'judge');
  const escalated = decision.outcome === 'human';
  const cost =
    (judgeConsulted ? judgeCallPrice : PRICES.ruleDecision) +
    (escalated ? PRICES.humanReview + PRICES.escalationRetry : 0);
  return { cost: round6(cost), modelCalls: judgeConsulted ? 1 : 0, escalated };
}

/** Run both arms over `tasks` (defaults to the full synthetic set). */
export async function runEval(tasks: readonly EvalTask[] = evalTasks): Promise<EvalRun> {
  const tierclefGate = defineGate({ rules: makeMergeRules(), judge: new MockJudge() });
  const baselineGate = defineGate({
    rules: makeMergeRules(),
    judge: new PermissiveFrontierMock(),
  });

  const tierclef: ArmOutcome[] = [];
  const baseline: ArmOutcome[] = [];

  for (const task of tasks) {
    if (task.kind === 'merge') {
      const decision = await tierclefGate.decide(task.input);
      const priced = mergeCost(decision, PRICES.cheapCall);
      tierclef.push({
        id: task.id,
        kind: 'merge',
        expected: task.expected,
        outcome: decision.outcome,
        correct: decision.outcome === task.expected,
        ...priced,
        reason: decisionSummary(decision),
      });

      const baseDecision = await baselineGate.decide(task.input);
      const basePriced = mergeCost(baseDecision, PRICES.frontierCall);
      baseline.push({
        id: task.id,
        kind: 'merge',
        expected: task.expected,
        outcome: baseDecision.outcome,
        correct: baseDecision.outcome === task.expected,
        ...basePriced,
        reason: decisionSummary(baseDecision),
      });
    } else {
      const routed = scoreRoute(task.input);
      const actual: Outcome = routed.tier;
      tierclef.push({
        id: task.id,
        kind: 'route',
        expected: task.expected,
        outcome: actual,
        correct: actual === task.expected,
        cost: round6(ROUTE_TIER_PRICE[routed.tier]),
        modelCalls: 1,
        escalated: false,
        reason: `scoreRoute tier=${routed.tier}${routed.abstained ? ' (low-confidence, tier raised)' : ''}`,
      });
      baseline.push({
        id: task.id,
        kind: 'route',
        expected: task.expected,
        outcome: 'frontier',
        correct: actual === task.expected,
        cost: PRICES.frontierCall,
        modelCalls: 1,
        escalated: false,
        reason: 'baseline: every task runs on the frontier tier',
      });
    }
  }

  return { tasks, tierclef, baseline };
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

export interface ArmMetrics {
  accuracy: number;
  correct: number;
  total: number;
  mergeAccuracy: number | null;
  routeAccuracy: number | null;
  totalCost: number;
  /** Merge tasks whose outcome is 'allow' (approved). */
  approvedCount: number;
  /** totalCost / max(1, approvedCount) — whole arm over merge allows. */
  costPerApproved: number;
  mergeCost: number;
  routeCost: number;
  routeCostPerTask: number | null;
  modelCalls: number;
  estimatedTokens: number;
  /** Merge tasks with an explicit human outcome. */
  escalations: number;
  /** Merge tasks expected 'allow' that ended block or human. */
  falseBlocks: number;
  /** falseBlocks / expected-allow count (null when no expected-allow tasks). */
  falseBlockRate: number | null;
  /** Fraction of escalations whose expected outcome is human or block. */
  escalationPrecision: number | null;
}

export interface EvalMetrics {
  tierclef: ArmMetrics;
  baseline: ArmMetrics;
  /** tierclef.accuracy - baseline.accuracy (quality parity; positive = tierclef better). */
  qualityParity: number;
}

export function computeMetrics(run: {
  tierclef: ArmOutcome[];
  baseline: ArmOutcome[];
  tasks?: readonly EvalTask[];
}): EvalMetrics {
  const knownIds = new Set((run.tasks ?? []).filter((t) => t.knownWeakness === true).map((t) => t.id));
  const arm = (records: ArmOutcome[]): ArmMetrics => {
    const scored = records.filter((r) => !knownIds.has(r.id));
    const total = scored.length;
    const merge = scored.filter((r) => r.kind === 'merge');
    const route = scored.filter((r) => r.kind === 'route');
    const correct = scored.filter((r) => r.correct).length;
    const mergeCorrect = merge.filter((r) => r.correct).length;
    const routeCorrect = route.filter((r) => r.correct).length;

    const totalCost = round6(records.reduce((sum, r) => sum + r.cost, 0));
    const mergeCost = round6(merge.reduce((sum, r) => sum + r.cost, 0));
    const routeCost = round6(route.reduce((sum, r) => sum + r.cost, 0));
    const approvedCount = merge.filter((r) => r.outcome === 'allow').length;
    const modelCalls = records.reduce((sum, r) => sum + r.modelCalls, 0);

    const expectedAllow = merge.filter((r) => r.expected === 'allow');
    const falseBlocks = expectedAllow.filter(
      (r) => r.outcome === 'block' || r.outcome === 'human',
    ).length;
    const escalations = merge.filter((r) => r.outcome === 'human').length;
    const warranted = merge.filter(
      (r) => r.outcome === 'human' && (r.expected === 'human' || r.expected === 'block'),
    ).length;

    return {
      accuracy: total > 0 ? correct / total : 0,
      correct,
      total,
      mergeAccuracy: merge.length > 0 ? mergeCorrect / merge.length : null,
      routeAccuracy: route.length > 0 ? routeCorrect / route.length : null,
      totalCost,
      approvedCount,
      costPerApproved: round6(totalCost / Math.max(1, approvedCount)),
      mergeCost,
      routeCost,
      routeCostPerTask: route.length > 0 ? round6(routeCost / route.length) : null,
      modelCalls,
      estimatedTokens: modelCalls * PRICES.tokensPerCall,
      escalations,
      falseBlocks,
      falseBlockRate: expectedAllow.length > 0 ? falseBlocks / expectedAllow.length : null,
      escalationPrecision: escalations > 0 ? warranted / escalations : null,
    };
  };

  const tierclef = arm(run.tierclef);
  const baseline = arm(run.baseline);
  return { tierclef, baseline, qualityParity: round6(tierclef.accuracy - baseline.accuracy) };
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

function pct(value: number | null): string {
  return value === null ? 'n/a' : (100 * value).toFixed(2) + '%';
}

function money(value: number): string {
  return '$' + value.toFixed(4);
}

function mark(ok: boolean): string {
  return ok ? 'ok' : 'X';
}

export function formatReport(run: { tierclef: ArmOutcome[]; baseline: ArmOutcome[]; tasks?: readonly EvalTask[] }, metrics: EvalMetrics): string {
  const lines: string[] = [];
  const push = (text = ''): void => {
    lines.push(text);
  };

  const mergeCount = run.tierclef.filter((r) => r.kind === 'merge').length;
  const routeCount = run.tierclef.filter((r) => r.kind === 'route').length;

  push('# tierclef eval report (generatedFrom: mock)');
  push();
  push(
    `Tasks: ${run.tierclef.length} synthetic (${mergeCount} merge, ${routeCount} route). ` +
      'Deterministic: mock judges and keyword routing only, no network, no API keys, fake secrets only.',
  );
  push();
  push('## Arms');
  push(
    '- TIERCLEF: merge rules first (free), grey zone to a cheap mock judge that can abstain; ' +
      'uncertain or irreversible grey merges go to a human. Route tasks tiered by scoreRoute.',
  );
  push(
    '- ALL-FRONTIER (baseline simulation): same merge rules, but every grey-zone merge goes to a ' +
      'frontier-priced mock that always allows and never abstains; every route task runs on frontier.',
  );
  push();
  push('## Quality parity');
  push('arm            accuracy   merge     route');
  push(
    `tierclef            ${pct(metrics.tierclef.accuracy).padEnd(10)} ${pct(metrics.tierclef.mergeAccuracy).padEnd(9)} ${pct(metrics.tierclef.routeAccuracy)}`,
  );
  push(
    `all-frontier   ${pct(metrics.baseline.accuracy).padEnd(10)} ${pct(metrics.baseline.mergeAccuracy).padEnd(9)} ${pct(metrics.baseline.routeAccuracy)}`,
  );
  push(`parity (tierclef - baseline): ${(100 * metrics.qualityParity).toFixed(2)}pp`);
  push();
  push('## Known weaknesses');
  const knownIds = new Set((run.tasks ?? []).filter((t) => t.knownWeakness === true).map((t) => t.id));
  const known = run.tierclef.filter((r) => knownIds.has(r.id));
  push(`count: ${known.length}`);
  for (const r of known) push(`- ${r.id}: expected=${r.expected} actual=${r.outcome}${r.correct ? ' — fixed — remove marker' : ''}`);
  push();
  push('## Cost (mock prices)');
  push(
    `prices: rule decision ${money(PRICES.ruleDecision)} | cheap call ${money(PRICES.cheapCall)} | mid call ${money(PRICES.midCall)} (assumption) | frontier call ${money(PRICES.frontierCall)} | human review ${money(PRICES.humanReview)} | escalation retry ${money(PRICES.escalationRetry)} | ~${PRICES.tokensPerCall} tokens per model call`,
  );
  push('arm            totalCost   approved(allow)   costPerApproved   modelCalls   estTokens');
  push(
    `tierclef            ${money(metrics.tierclef.totalCost).padEnd(11)} ${String(metrics.tierclef.approvedCount).padEnd(17)} ${money(metrics.tierclef.costPerApproved).padEnd(17)} ${String(metrics.tierclef.modelCalls).padEnd(12)} ${metrics.tierclef.estimatedTokens}`,
  );
  push(
    `all-frontier   ${money(metrics.baseline.totalCost).padEnd(11)} ${String(metrics.baseline.approvedCount).padEnd(17)} ${money(metrics.baseline.costPerApproved).padEnd(17)} ${String(metrics.baseline.modelCalls).padEnd(12)} ${metrics.baseline.estimatedTokens}`,
  );
  push(
    `route cost per task: tierclef ${metrics.tierclef.routeCostPerTask === null ? 'n/a' : money(metrics.tierclef.routeCostPerTask)} vs baseline ${metrics.baseline.routeCostPerTask === null ? 'n/a' : money(metrics.baseline.routeCostPerTask)}`,
  );
  push();
  push('## Safety');
  const expectedAllowCount = run.tierclef.filter(
    (r) => r.kind === 'merge' && r.expected === 'allow',
  ).length;
  push(
    `- false-block rate (tierclef): ${pct(metrics.tierclef.falseBlockRate)} (${metrics.tierclef.falseBlocks} of ${expectedAllowCount} expected-allow merge tasks blocked or sent to human)`,
  );
  push(
    `- escalation precision (tierclef): ${pct(metrics.tierclef.escalationPrecision)} (${metrics.tierclef.escalations} human escalations, warranted when expected is human/block)`,
  );
  push();
  push('## Limitations');
  push(
    '- The ALL-FRONTIER arm is a simulation, not a real frontier judge: its mock always allows and ' +
      'never abstains. A real frontier model would sometimes block or abstain, so the parity number is ' +
      'directional — it illustrates confident permissiveness without an abstention channel.',
  );
  push(
    '- costPerApproved rewards rubber-stamping (the baseline "approves" tasks tierclef correctly escalates). ' +
      'Read it next to total cost, accuracy and the safety metrics, never alone.',
  );
  push(
    '- All tasks are synthetic; all secrets are fake (FAKE_EXAMPLE_ONLY_*). Prices are mock constants, ' +
      'not quotes from any provider. Token counts are estimates (~400/call).',
  );
  push();
  push('## Per task');
  push('id                                kind   expected   tierclef       ok  baseline  ok');
  run.tierclef.forEach((tierclefRecord, i) => {
    const base = run.baseline[i];
    if (!base) return;
    push(
      `${tierclefRecord.id.padEnd(33)} ${tierclefRecord.kind.padEnd(6)} ${tierclefRecord.expected.padEnd(10)} ${String(tierclefRecord.outcome).padEnd(9)} ${mark(tierclefRecord.correct).padEnd(3)} ${String(base.outcome).padEnd(9)} ${mark(base.correct)}`,
    );
  });
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * main: stdout report + eval/report.json (deterministic, no timestamps)
 * ------------------------------------------------------------------ */

const REPORT_PATH = fileURLToPath(new URL('../../eval/report.json', import.meta.url));

export interface PerTaskReport {
  id: string;
  kind: 'merge' | 'route';
  expected: ExpectedOutcome;
  note: string;
  knownWeakness?: true;
  tierclef: { outcome: Outcome; correct: boolean; cost: number; reason: string };
  baseline: { outcome: Outcome; correct: boolean; cost: number; reason: string };
}

export interface EvalReport {
  generatedFrom: 'mock';
  prices: typeof PRICES;
  metrics: EvalMetrics;
  perTask: PerTaskReport[];
  knownWeaknesses: Array<{ id: string; expected: ExpectedOutcome; actual: Outcome; fixed: boolean }>;
}

export function buildReport(run: EvalRun, metrics: EvalMetrics): EvalReport {
  const perTask: PerTaskReport[] = run.tierclef.map((tierclefRecord, i) => {
    const base = run.baseline[i];
    const task = run.tasks[i];
    if (!base || !task) {
      throw new Error(`runEval output misaligned at index ${i}`);
    }
    return {
      id: task.id,
      kind: task.kind,
      expected: task.expected,
      note: task.note,
      ...(task.knownWeakness ? { knownWeakness: true as const } : {}),
      tierclef: {
        outcome: tierclefRecord.outcome,
        correct: tierclefRecord.correct,
        cost: tierclefRecord.cost,
        reason: tierclefRecord.reason,
      },
      baseline: {
        outcome: base.outcome,
        correct: base.correct,
        cost: base.cost,
        reason: base.reason,
      },
    };
  });
  const knownWeaknesses = perTask.filter((t) => t.knownWeakness).map((t) => ({
    id: t.id,
    expected: t.expected,
    actual: t.tierclef.outcome,
    fixed: t.tierclef.correct,
  }));
  return { generatedFrom: 'mock', prices: PRICES, metrics, perTask, knownWeaknesses };
}

export async function main(): Promise<void> {
  const run = await runEval();
  const metrics = computeMetrics({ ...run, tasks: run.tasks });
  process.stdout.write(formatReport({ ...run, tasks: run.tasks }, metrics));
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify(buildReport(run, metrics), null, 2) + '\n', 'utf8');
  process.stdout.write(`\nreport json: ${REPORT_PATH}\n`);
}

const invokedAsScript = (() => {
  try {
    const entry = process.argv[1];
    return (
      typeof entry === 'string' && import.meta.url === pathToFileURL(realpathSync(entry)).href
    );
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main().catch((err: unknown) => {
    process.stderr.write(`tierclef eval: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
