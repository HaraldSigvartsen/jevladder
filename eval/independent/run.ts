#!/usr/bin/env node
/**
 * Independent eval runner: policy-labelled tasks vs current jev behaviour.
 *
 * Merge: makeMergeRules() + MockJudge via defineGate.
 * Route: scoreRoute.
 *
 * Writes eval/independent/report.json (deterministic, no timestamps).
 * Does NOT assert high accuracy — misses are the point of an independent set.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineGate, type Decision } from '../../src/gate.js';
import { makeMergeRules } from '../../src/rules/merge-rules.js';
import { MockJudge } from '../../src/judge/mock.js';
import { scoreRoute, type RouteTier } from '../../src/route.js';
import {
  independentTasks,
  type IndependentTask,
  type MergeExpected,
  type RouteExpected,
} from './tasks.js';

export type ActualOutcome = MergeExpected | RouteExpected;

export interface IndependentMiss {
  id: string;
  kind: 'merge' | 'route';
  expected: ActualOutcome;
  actual: ActualOutcome;
  policyRef: string;
  predictedRisk: boolean;
  reason: string;
  note: string;
}

export interface IndependentResult {
  id: string;
  kind: 'merge' | 'route';
  expected: ActualOutcome;
  actual: ActualOutcome;
  correct: boolean;
  policyRef: string;
  predictedRisk: boolean;
  reason: string;
  note: string;
  scenario: string;
}

export interface IndependentRun {
  results: IndependentResult[];
  misses: IndependentMiss[];
  accuracy: number;
  mergeAccuracy: number | null;
  routeAccuracy: number | null;
  total: number;
  correct: number;
}

function decisionSummary(decision: Decision): string {
  return decision.source + (decision.ruleId ? ':' + decision.ruleId : '');
}

/** Run the independent set (defaults to the full curated list). */
export async function runIndependentEval(
  tasks: readonly IndependentTask[] = independentTasks,
): Promise<IndependentRun> {
  const gate = defineGate({ rules: makeMergeRules(), judge: new MockJudge() });
  const results: IndependentResult[] = [];

  for (const task of tasks) {
    if (task.kind === 'merge') {
      const decision = await gate.decide(task.input);
      const actual = decision.outcome;
      results.push({
        id: task.id,
        kind: 'merge',
        expected: task.expected,
        actual,
        correct: actual === task.expected,
        policyRef: task.policyRef,
        predictedRisk: task.predictedRisk === true,
        reason: decisionSummary(decision),
        note: task.note,
        scenario: task.scenario,
      });
    } else {
      const routed = scoreRoute(task.input);
      const actual: RouteTier = routed.tier;
      results.push({
        id: task.id,
        kind: 'route',
        expected: task.expected,
        actual,
        correct: actual === task.expected,
        policyRef: task.policyRef,
        predictedRisk: task.predictedRisk === true,
        reason: `scoreRoute tier=${routed.tier}${routed.abstained ? ' (low-confidence, tier raised)' : ''}`,
        note: task.note,
        scenario: task.scenario,
      });
    }
  }

  const misses: IndependentMiss[] = results
    .filter((r) => !r.correct)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      expected: r.expected,
      actual: r.actual,
      policyRef: r.policyRef,
      predictedRisk: r.predictedRisk,
      reason: r.reason,
      note: r.note,
    }));

  const merge = results.filter((r) => r.kind === 'merge');
  const route = results.filter((r) => r.kind === 'route');
  const correct = results.filter((r) => r.correct).length;
  const total = results.length;

  return {
    results,
    misses,
    accuracy: total > 0 ? correct / total : 0,
    mergeAccuracy: merge.length > 0 ? merge.filter((r) => r.correct).length / merge.length : null,
    routeAccuracy: route.length > 0 ? route.filter((r) => r.correct).length / route.length : null,
    total,
    correct,
  };
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : (100 * value).toFixed(2) + '%';
}

export function formatIndependentReport(run: IndependentRun): string {
  const lines: string[] = [];
  const push = (t = ''): void => {
    lines.push(t);
  };

  const mergeCount = run.results.filter((r) => r.kind === 'merge').length;
  const routeCount = run.results.filter((r) => r.kind === 'route').length;

  push('# jev independent eval report');
  push();
  push(
    `Tasks: ${run.total} (${mergeCount} merge, ${routeCount} route). ` +
      'Labels from scenario + policy.md; MockJudge + scoreRoute only; deterministic.',
  );
  push();
  push('## Accuracy');
  push(`overall   ${pct(run.accuracy)}  (${run.correct}/${run.total})`);
  push(`merge     ${pct(run.mergeAccuracy)}`);
  push(`route     ${pct(run.routeAccuracy)}`);
  push();
  push('## Misses');
  if (run.misses.length === 0) {
    push('(none)');
  } else {
    for (const m of run.misses) {
      push(
        `- ${m.id}: expected=${m.expected} actual=${m.actual} ` +
          `(${m.policyRef}${m.predictedRisk ? ', predictedRisk' : ''}) reason=${m.reason}`,
      );
    }
  }
  push();
  push('## Per task');
  push('id                                       kind   expected  actual    ok  risk');
  for (const r of run.results) {
    push(
      `${r.id.padEnd(40)} ${r.kind.padEnd(6)} ${String(r.expected).padEnd(9)} ${String(r.actual).padEnd(9)} ${(r.correct ? 'ok' : 'X').padEnd(3)} ${r.predictedRisk ? 'yes' : 'no'}`,
    );
  }
  return lines.join('\n') + '\n';
}

export interface IndependentReport {
  generatedFrom: 'independent-policy';
  accuracy: number;
  mergeAccuracy: number | null;
  routeAccuracy: number | null;
  total: number;
  correct: number;
  misses: IndependentMiss[];
  perTask: IndependentResult[];
}

export function buildIndependentReport(run: IndependentRun): IndependentReport {
  return {
    generatedFrom: 'independent-policy',
    accuracy: run.accuracy,
    mergeAccuracy: run.mergeAccuracy,
    routeAccuracy: run.routeAccuracy,
    total: run.total,
    correct: run.correct,
    misses: run.misses,
    perTask: run.results,
  };
}

const REPORT_PATH = fileURLToPath(new URL('../../../eval/independent/report.json', import.meta.url));

export async function main(): Promise<void> {
  const run = await runIndependentEval();
  process.stdout.write(formatIndependentReport(run));
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(
    REPORT_PATH,
    JSON.stringify(buildIndependentReport(run), null, 2) + '\n',
    'utf8',
  );
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
    process.stderr.write(
      `jev independent eval: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
