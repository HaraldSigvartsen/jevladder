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
  tierclef: [
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
    expect(metrics.tierclef.accuracy).toBeCloseTo(0.75, 10);
    expect(metrics.tierclef.mergeAccuracy).toBeCloseTo(2 / 3, 10);
    expect(metrics.tierclef.routeAccuracy).toBe(1);
    expect(metrics.baseline.accuracy).toBe(0.5);
    expect(metrics.qualityParity).toBeCloseTo(0.25, 10);
  });

  it('computes costs, approvals and token estimates', () => {
    expect(metrics.tierclef.totalCost).toBeCloseTo(0.256, 6);
    expect(metrics.tierclef.approvedCount).toBe(1);
    expect(metrics.tierclef.costPerApproved).toBeCloseTo(0.256, 6);
    expect(metrics.tierclef.modelCalls).toBe(3);
    expect(metrics.tierclef.estimatedTokens).toBe(3 * PRICES.tokensPerCall);
    expect(metrics.baseline.totalCost).toBeCloseTo(0.2, 6);
    expect(metrics.baseline.approvedCount).toBe(3);
    expect(metrics.baseline.costPerApproved).toBeCloseTo(0.2 / 3, 6);
  });

  it('computes false-block rate and escalation precision', () => {
    expect(metrics.tierclef.falseBlocks).toBe(1);
    expect(metrics.tierclef.falseBlockRate).toBe(0.5);
    expect(metrics.tierclef.escalations).toBe(1);
    expect(metrics.tierclef.escalationPrecision).toBe(1);
    expect(metrics.baseline.escalations).toBe(0);
    expect(metrics.baseline.escalationPrecision).toBeNull();
  });
});

describe('known weakness scenarios', () => {
  it('are marked with correct labels and currently fail', async () => {
    const cases = evalTasks.filter((task) => task.knownWeakness === true);
    expect(cases.map((task) => task.id)).toEqual([
      'm-human-unprotected-binary-diff',
      'route-reject-empty-task',
    ]);
    expect(cases.map((task) => task.expected)).toEqual(['human', 'reject']);
    const run = await runEval(cases);
    expect(run.tierclef.every((result) => !result.correct)).toBe(true);
    const metrics = computeMetrics({ ...run, tasks: run.tasks });
    expect(metrics.tierclef.total).toBe(0);
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
  it('achieves tierclef accuracy >= 0.8 and >= baseline', async () => {
    const metrics = computeMetrics(await runEval());
    expect(metrics.tierclef.accuracy).toBeGreaterThanOrEqual(0.8);
    expect(metrics.tierclef.accuracy).toBeGreaterThanOrEqual(metrics.baseline.accuracy);
  });

  it('is deterministic across runs', async () => {
    const a = computeMetrics(await runEval());
    const b = computeMetrics(await runEval());
    expect(a).toEqual(b);
  });
});
