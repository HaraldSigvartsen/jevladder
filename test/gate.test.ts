import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_THRESHOLD,
  defineGate,
  parseJudgeVerdict,
  type GateInput,
  type Judge,
} from '../src/index.js';

const baseInput: GateInput = { action: 'edit src/gate.ts' };

/** A judge that returns `raw` and records whether it was consulted. */
function judgeReturning(raw: unknown): { judge: Judge; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async (): Promise<unknown> => raw);
  return { judge: { judge: spy }, spy };
}

describe('rule evaluation', () => {
  it('first matching rule decides allow without calling the judge', async () => {
    const { judge, spy } = judgeReturning({
      verdict: 'allow',
      score: 0.99,
      evidence: 'should never matter',
    });
    const gate = defineGate({
      rules: [
        { id: 'trusted-edit', evaluate: () => ({ outcome: 'allow', reason: 'trusted action' }) },
        { id: 'unreachable', evaluate: () => ({ outcome: 'block', reason: 'never reached' }) },
      ],
      judge,
    });

    const decision = await gate.decide(baseInput);

    expect(decision.outcome).toBe('allow');
    expect(decision.source).toBe('rule');
    expect(decision.ruleId).toBe('trusted-edit');
    expect(decision.reason).toBe('trusted action');
    expect(spy).not.toHaveBeenCalled();
    expect(decision.log.some((e) => e.stage === 'rule' && e.detail.includes('trusted-edit'))).toBe(true);
  });

  it('first matching rule decides block without calling the judge', async () => {
    const { judge, spy } = judgeReturning({
      verdict: 'allow',
      score: 0.99,
      evidence: 'should never matter',
    });
    const gate = defineGate({
      rules: [
        { id: 'miss', evaluate: () => null },
        {
          id: 'deny-rm-rf',
          evaluate: (input) =>
            input.action.includes('rm -rf') ? { outcome: 'block', reason: 'destructive command' } : null,
        },
      ],
      judge,
    });

    const decision = await gate.decide({ action: 'run rm -rf /' });

    expect(decision.outcome).toBe('block');
    expect(decision.source).toBe('rule');
    expect(decision.ruleId).toBe('deny-rm-rf');
    expect(spy).not.toHaveBeenCalled();
  });

  it('rules run in order: an earlier miss does not decide, a later hit does', async () => {
    const gate = defineGate({
      rules: [
        { id: 'first-miss', evaluate: () => null },
        { id: 'second-hit', evaluate: () => ({ outcome: 'block', reason: 'second rule hit' }) },
        { id: 'third', evaluate: () => ({ outcome: 'allow', reason: 'never reached' }) },
      ],
    });

    const decision = await gate.decide(baseInput);

    expect(decision.outcome).toBe('block');
    expect(decision.ruleId).toBe('second-hit');
  });

  it('a throwing rule is treated as a miss, not a crash', async () => {
    const gate = defineGate({
      rules: [
        {
          id: 'broken',
          evaluate: () => {
            throw new Error('rule bug');
          },
        },
        { id: 'healthy', evaluate: () => ({ outcome: 'allow', reason: 'still runs' }) },
      ],
    });

    const decision = await gate.decide(baseInput);

    expect(decision.outcome).toBe('allow');
    expect(decision.ruleId).toBe('healthy');
    expect(decision.log.some((e) => e.stage === 'rule' && e.detail.includes('broken'))).toBe(true);
  });
});

describe('grey zone (judge)', () => {
  it('judge allow at or above threshold allows', async () => {
    const gate = defineGate({
      rules: [],
      judge: judgeReturning({ verdict: 'allow', score: DEFAULT_THRESHOLD, evidence: 'routine edit' }).judge,
    });

    const decision = await gate.decide(baseInput);

    expect(decision.outcome).toBe('allow');
    expect(decision.source).toBe('judge');
    expect(decision.judgeVerdict).toEqual({ verdict: 'allow', score: 0.7, evidence: 'routine edit' });
    expect(decision.reason).toBe('routine edit');
  });

  it('judge block at or above threshold blocks', async () => {
    const gate = defineGate({
      rules: [],
      judge: judgeReturning({ verdict: 'block', score: 0.92, evidence: 'destructive sql' }).judge,
    });

    const decision = await gate.decide({ action: 'run raw sql' });

    expect(decision.outcome).toBe('block');
    expect(decision.source).toBe('judge');
  });

  it('judge allow below threshold defers to human', async () => {
    const onUncertain = vi.fn();
    const gate = defineGate({
      rules: [],
      judge: judgeReturning({ verdict: 'allow', score: 0.5, evidence: 'shaky' }).judge,
      onUncertain,
    });

    const decision = await gate.decide(baseInput);

    expect(decision.outcome).toBe('human');
    expect(decision.source).toBe('human');
    expect(decision.judgeVerdict?.score).toBe(0.5);
    expect(onUncertain).toHaveBeenCalledTimes(1);
  });

  it('judge abstain defers to human regardless of score', async () => {
    const gate = defineGate({
      rules: [],
      judge: judgeReturning({ verdict: 'abstain', score: 0.95, evidence: 'not confident' }).judge,
    });

    const decision = await gate.decide(baseInput);

    expect(decision.outcome).toBe('human');
    expect(decision.reason).toContain('abstained');
  });

  it('honours a custom threshold', async () => {
    const strict = defineGate({
      threshold: 0.9,
      judge: judgeReturning({ verdict: 'allow', score: 0.85, evidence: 'decent' }).judge,
    });
    const lenient = defineGate({
      threshold: 0.5,
      judge: judgeReturning({ verdict: 'allow', score: 0.85, evidence: 'decent' }).judge,
    });

    expect((await strict.decide(baseInput)).outcome).toBe('human');
    expect((await lenient.decide(baseInput)).outcome).toBe('allow');
  });
});

describe('malformed judge output never fails open', () => {
  const malformed: unknown[] = [
    null,
    'allow',
    42,
    true,
    [],
    {},
    { verdict: 'allow' },
    { verdict: 'yes', score: 0.9, evidence: 'unknown verdict' },
    { verdict: 'allow', score: 2, evidence: 'score too high' },
    { verdict: 'block', score: -0.1, evidence: 'score negative' },
    { verdict: 'allow', score: Number.NaN, evidence: 'score NaN' },
    { verdict: 'allow', score: '0.9', evidence: 'score as string' },
    { verdict: 'allow', score: 0.9 },
    { verdict: 'allow', score: 0.9, evidence: '' },
    { verdict: 'allow', score: 0.9, evidence: 7 },
  ];

  for (const raw of malformed) {
    it(`treats ${JSON.stringify(raw)} as uncertain and defers to human`, async () => {
      const onUncertain = vi.fn();
      const gate = defineGate({
        rules: [],
        judge: judgeReturning(raw).judge,
        onUncertain,
      });

      const decision = await gate.decide(baseInput);

      expect(decision.outcome).toBe('human');
      expect(decision.judgeVerdict).toBeUndefined();
      expect(decision.reason).toContain('invalid');
      expect(onUncertain).toHaveBeenCalledTimes(1);
    });
  }

  it('a throwing judge defers to human instead of crashing', async () => {
    const gate = defineGate({
      rules: [],
      judge: {
        judge: async () => {
          throw new Error('network down');
        },
      },
    });

    const decision = await gate.decide(baseInput);

    expect(decision.outcome).toBe('human');
    expect(decision.reason).toContain('network down');
  });
});

describe('irreversible actions', () => {
  it('judge allow can never approve an irreversible action alone', async () => {
    const onUncertain = vi.fn();
    const gate = defineGate({
      rules: [],
      judge: judgeReturning({ verdict: 'allow', score: 0.99, evidence: 'looks fine' }).judge,
      onUncertain,
    });

    const decision = await gate.decide({ action: 'drop database', irreversible: true });

    expect(decision.outcome).toBe('human');
    expect(decision.source).toBe('human');
    expect(decision.judgeVerdict?.verdict).toBe('allow');
    expect(decision.reason).toContain('irreversible');
    expect(onUncertain).toHaveBeenCalledTimes(1);
    expect(decision.log.some((e) => e.stage === 'irreversible')).toBe(true);
  });

  it('judge block still blocks an irreversible action', async () => {
    const gate = defineGate({
      rules: [],
      judge: judgeReturning({ verdict: 'block', score: 0.95, evidence: 'clearly dangerous' }).judge,
    });

    const decision = await gate.decide({ action: 'drop database', irreversible: true });

    expect(decision.outcome).toBe('block');
    expect(decision.source).toBe('judge');
  });
});

describe('fallbacks and uncertainty callback', () => {
  it('no rules and no judge defers to human with source none', async () => {
    const gate = defineGate({ rules: [] });

    const decision = await gate.decide(baseInput);

    expect(decision.outcome).toBe('human');
    expect(decision.source).toBe('none');
    expect(decision.log.some((e) => e.stage === 'fallback')).toBe(true);
  });

  it('onUncertain is not invoked when the decision is not human', async () => {
    const onUncertain = vi.fn();
    const gate = defineGate({
      rules: [{ id: 'allow-all', evaluate: () => ({ outcome: 'allow', reason: 'fine' }) }],
      onUncertain,
    });

    await gate.decide(baseInput);

    expect(onUncertain).not.toHaveBeenCalled();
  });

  it('a failing onUncertain callback is logged, not thrown', async () => {
    const gate = defineGate({
      rules: [],
      onUncertain: () => {
        throw new Error('notifier broken');
      },
    });

    const decision = await gate.decide(baseInput);

    expect(decision.outcome).toBe('human');
    expect(decision.log.some((e) => e.stage === 'fallback' && e.detail.includes('notifier broken'))).toBe(true);
  });
});

describe('decision log', () => {
  it('entries are structured (ts, stage, detail) and end with a decision entry', async () => {
    const gate = defineGate({
      rules: [{ id: 'r1', evaluate: () => null }],
      judge: judgeReturning({ verdict: 'allow', score: 0.8, evidence: 'ok' }).judge,
    });

    const decision = await gate.decide(baseInput);

    expect(decision.log.length).toBeGreaterThan(0);
    for (const logEntry of decision.log) {
      expect(typeof logEntry.ts).toBe('string');
      expect(logEntry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof logEntry.stage).toBe('string');
      expect(logEntry.detail.length).toBeGreaterThan(0);
    }
    expect(decision.log.at(-1)?.stage).toBe('decision');
  });
});

describe('parseJudgeVerdict', () => {
  it('accepts a well-formed verdict and tolerates extra keys', () => {
    const parsed = parseJudgeVerdict({
      verdict: 'block',
      score: 0.9,
      evidence: 'danger',
      extra: 'ignored',
    });
    expect(parsed).toEqual({ ok: true, value: { verdict: 'block', score: 0.9, evidence: 'danger' } });
  });

  it('supports caller-provided verdict enums, mapping non-allow/block members to the abstain path', () => {
    expect(parseJudgeVerdict({ verdict: 'maybe', score: 0.9, evidence: 'hmm' }, ['allow', 'block', 'maybe']).ok).toBe(true);
    expect(parseJudgeVerdict({ verdict: 'abstain', score: 0.9, evidence: 'hmm' }, ['allow', 'block', 'maybe']).ok).toBe(false);
  });
});

describe('defineGate configuration validation', () => {
  it('rejects an out-of-range threshold at definition time', () => {
    expect(() => defineGate({ threshold: 1.5 })).toThrow(RangeError);
    expect(() => defineGate({ threshold: 0.5 })).not.toThrow();
  });

  it('rejects malformed rules at definition time', () => {
    expect(() => defineGate({ rules: [{ id: '', evaluate: () => null }] })).toThrow(TypeError);
    expect(() =>
      defineGate({
        rules: [{ id: 'x', evaluate: null as unknown as () => null }],
      }),
    ).toThrow(TypeError);
  });

  it('rejects a judge without a judge method at definition time', () => {
    expect(() => defineGate({ judge: {} as unknown as Judge })).toThrow(TypeError);
  });
});
