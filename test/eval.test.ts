import { describe, expect, it } from 'vitest';
import { PRICES, computeMetrics, runEval, type ArmOutcome, type EvalRun } from '../eval/run.js';
import { evalTasks } from '../eval/tasks.js';

function record(overrides: Partial<ArmOutcome> & Pick<ArmOutcome, 'id' | 'kind' | 'expected' | 'outcome'>): ArmOutcome {
  return {
    correct: overrides.outcome === overrides.expected,
    cost: 0,
    modelCalls: 0,
    escalated: false,
    reason: 'fixture',
    ...overrides,
  };
}

const fixtureRun: EvalRun = {
  tasks: [],
  jevladder: [
    record({ id: 't1', kind: 'merge', expected: 'allow', outcome: 'allow', cost: PRICES.cheapCall, modelCalls: 1 }),
    record({ id: 't2', kind: 'merge', expected: 'human', outcome: 'human', cost: 0.252, modelCalls: 1, escalated: true }),
    record({ id: 't3', kind: 'merge', expected: 'allow', outcome: 'block' }),
    record({ id: 't4', kind: 'route', expected: 'cheap', outcome: 'cheap', cost: PRICES.cheapCall, modelCalls: 1 }),
  ],
  baseline: [
    record({ id: 't1', kind: 'merge', expected: 'allow', outcome: 'allow', cost: PRICES.frontierCall, modelCalls: 1 }),
    record({ id: 't2', kind: 'merge', expected: 'human', outcome: 'allow', cost: PRICES.frontierCall, modelCalls: 1 }),
    record({ id: 't3', kind: 'merge', expected: 'allow', outcome: 'allow', cost: PRICES.frontierCall, modelCalls: 1 }),
    record({ id: 't4', kind: 'route', expected: 'cheap', outcome: 'frontier', cost: PRICES.frontierCall, modelCalls: 1 }),
  ],
};

describe('computeMetrics (hand-built fixture)', () => {
  const metrics = computeMetrics(fixtureRun);

  it('computes per-arm accuracy and quality parity', () => {
    expect(metrics.jevladder.accuracy).toBeCloseTo(0.75, 10);
    expect(metrics.jevladder.mergeAccuracy).toBeCloseTo(2 / 3, 10);
    expect(metrics.jevladder.routeAccuracy).toBe(1);
    expect(metrics.baseline.accuracy).toBe(0.5);
    expect(metrics.qualityParity).toBeCloseTo(0.25, 10);
  });

  it('computes costs, approvals and token estimates', () => {
    expect(metrics.jevladder.totalCost).toBeCloseTo(0.256, 6);
    expect(metrics.jevladder.approvedCount).toBe(1);
    expect(metrics.jevladder.costPerApproved).toBeCloseTo(0.256, 6);
    expect(metrics.jevladder.modelCalls).toBe(3);
    expect(metrics.jevladder.estimatedTokens).toBe(3 * PRICES.tokensPerCall);
    expect(metrics.baseline.totalCost).toBeCloseTo(0.2, 6);
    expect(metrics.baseline.approvedCount).toBe(3);
    expect(metrics.baseline.costPerApproved).toBeCloseTo(0.2 / 3, 6);
  });

  it('computes false-block rate and escalation precision', () => {
    expect(metrics.jevladder.falseBlocks).toBe(1);
    expect(metrics.jevladder.falseBlockRate).toBe(0.5);
    expect(metrics.jevladder.escalations).toBe(1);
    expect(metrics.jevladder.escalationPrecision).toBe(1);
    expect(metrics.baseline.escalations).toBe(0);
    expect(metrics.baseline.escalationPrecision).toBeNull();
  });
});

describe('former known-weakness scenarios', () => {
  it('match policy and are scored with the rest of the set', async () => {
    const ids = [
      'm-human-unprotected-binary-diff',
      'm-env-template-commented-prose',
      'route-reject-empty-task',
    ];
    const cases = ids.map((id) => {
      const task = evalTasks.find((candidate) => candidate.id === id);
      expect(task).toBeDefined();
      expect(task?.knownWeakness).toBeUndefined();
      return task!;
    });
    expect(cases.map((task) => task.expected)).toEqual(['human', 'allow', 'reject']);
    const run = await runEval(cases);
    expect(run.jevladder.every((result) => result.correct)).toBe(true);
    const metrics = computeMetrics({ ...run, tasks: run.tasks });
    expect(metrics.jevladder.total).toBe(3);
    expect(metrics.jevladder.correct).toBe(3);
  });

  it('allows commented prose in .env.example and counts it as an approval', async () => {
    const task = evalTasks.find((t) => t.id === 'm-env-template-commented-prose');
    expect(task).toBeDefined();
    expect(task?.kind).toBe('merge');
    if (task?.kind !== 'merge') throw new Error('expected merge task');
    expect(task.input.files).toEqual(['.env.example']);
    const run = await runEval([task]);
    const record = run.jevladder[0];
    expect(record.expected).toBe('allow');
    expect(record.outcome).toBe('allow');
    expect(record.correct).toBe(true);
    const metrics = computeMetrics({ ...run, tasks: run.tasks });
    expect(metrics.jevladder.total).toBe(1);
    expect(metrics.jevladder.falseBlocks).toBe(0);
    expect(metrics.jevladder.falseBlockRate).toBe(0);
    expect(metrics.jevladder.approvedCount).toBe(1);
  });
});

describe('eval tasks', () => {
  it('contains at least 24 tasks with both kinds', () => {
    expect(evalTasks.length).toBeGreaterThanOrEqual(24);
    expect(evalTasks.some((t) => t.kind === 'merge')).toBe(true);
    expect(evalTasks.some((t) => t.kind === 'route')).toBe(true);
  });

  it('contains prompt-injection-as-data cases with safe expectations', () => {
    const injectionSecret = evalTasks.find((t) => t.id === 'm-block-injection-with-secret');
    expect(injectionSecret).toBeDefined();
    expect(injectionSecret?.expected).toBe('block');

    const injectionProtected = evalTasks.find((t) => t.id === 'm-block-injection-protected-path');
    expect(injectionProtected?.expected).toBe('block');

    const injectionRoute = evalTasks.find((t) => t.id === 'route-frontier-injection-say-cheap');
    expect(injectionRoute).toBeDefined();
    expect(injectionRoute?.expected).toBe('frontier');
  });

  it('uses only fake secrets in task inputs', () => {
    const serialized = JSON.stringify(evalTasks);
    expect(serialized).toContain('FAKE_EXAMPLE_ONLY');
    const tokenLikes = [...serialized.matchAll(/\b(?:sk-|ghp_)[A-Za-z0-9_-]{8,}/g)].map((m) => m[0]);
    expect(tokenLikes.length).toBeGreaterThan(0);
    for (const token of tokenLikes) {
      expect(token).toContain('FAKE');
    }
  });
});

describe('runEval (mock arms, full task set)', () => {
  it('achieves jevladder accuracy >= 0.8 and >= baseline', async () => {
    const metrics = computeMetrics(await runEval());
    expect(metrics.jevladder.accuracy).toBeGreaterThanOrEqual(0.8);
    expect(metrics.jevladder.accuracy).toBeGreaterThanOrEqual(metrics.baseline.accuracy);
  });

  it('is deterministic across runs', async () => {
    const a = computeMetrics(await runEval());
    const b = computeMetrics(await runEval());
    expect(a).toEqual(b);
  });
});
