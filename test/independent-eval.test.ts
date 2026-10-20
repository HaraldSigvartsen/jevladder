import { describe, expect, it } from 'vitest';
import { independentTasks } from '../eval/independent/tasks.js';
import { runIndependentEval } from '../eval/independent/run.js';

describe('independent eval tasks', () => {
  it('contains at least 20 scenarios with policyRef and scenario prose', () => {
    expect(independentTasks.length).toBeGreaterThanOrEqual(20);
    for (const task of independentTasks) {
      expect(task.policyRef).toMatch(/^[MR][1-5]$/);
      expect(task.scenario.trim().length).toBeGreaterThan(10);
      expect(task.note.trim().length).toBeGreaterThan(0);
    }
  });

  it('marks at least 6 predictedRisk cases', () => {
    const risky = independentTasks.filter((t) => t.predictedRisk === true);
    expect(risky.length).toBeGreaterThanOrEqual(6);
  });

  it('includes both merge and route kinds', () => {
    expect(independentTasks.some((t) => t.kind === 'merge')).toBe(true);
    expect(independentTasks.some((t) => t.kind === 'route')).toBe(true);
  });
});

describe('runIndependentEval', () => {
  it('returns accuracy in 0..1 and a misses array (no baseline floor)', async () => {
    const run = await runIndependentEval();
    expect(typeof run.accuracy).toBe('number');
    expect(run.accuracy).toBeGreaterThanOrEqual(0);
    expect(run.accuracy).toBeLessThanOrEqual(1);
    expect(Array.isArray(run.misses)).toBe(true);
    expect(run.total).toBe(independentTasks.filter((t) => !t.knownWeakness).length);
    expect(run.correct + run.misses.filter((m) => !m.knownWeakness).length).toBe(run.total);
    for (const miss of run.misses) {
      expect(miss.expected).not.toBe(miss.actual);
      expect(miss.id.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic across runs', async () => {
    const a = await runIndependentEval();
    const b = await runIndependentEval();
    expect(a.accuracy).toBe(b.accuracy);
    expect(a.misses).toEqual(b.misses);
  });
});
