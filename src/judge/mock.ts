/**
 * Deterministic mock judge for tests and local development. No API key, no
 * network, fully predictable.
 */
import type { GateInput, Judge } from '../gate.js';

/**
 * Build a mock judge.
 *
 * - `undefined`: use the default heuristic below.
 * - A function: called with the gate input, its result is returned verbatim.
 * - Any other value (including `null`): returned verbatim, which lets tests
 *   exercise the core's handling of malformed judge output.
 */
export type MockJudgeResponse = unknown;

/** Default allow score used by the heuristic when no risk signals are found. */
export const MOCK_ALLOW_SCORE = 0.85;

export class MockJudge implements Judge {
  private readonly fixed: unknown;
  private readonly hasFixed: boolean;
  private readonly fn?: (input: GateInput) => unknown | Promise<unknown>;

  constructor(response?: MockJudgeResponse) {
    if (typeof response === 'function') {
      this.fn = response as (input: GateInput) => unknown | Promise<unknown>;
      this.fixed = undefined;
      this.hasFixed = false;
    } else {
      this.fn = undefined;
      this.fixed = response;
      this.hasFixed = response !== undefined;
    }
  }

  /**
   * Default heuristic (when constructed without arguments):
   * 1. `context.mockVerdict` present and not `undefined` → returned verbatim.
   * 2. `diff` contains "TODO" or a file path contains "protected" → abstain.
   * 3. Otherwise → allow with score 0.85, evidence "mock: no risk signals".
   */
  async judge(input: GateInput): Promise<unknown> {
    if (this.fn) return this.fn(input);
    if (this.hasFixed) return this.fixed;

    const context = input?.context;
    if (
      typeof context === 'object' &&
      context !== null &&
      'mockVerdict' in context &&
      context.mockVerdict !== undefined
    ) {
      return context.mockVerdict;
    }
    if (typeof input.diff === 'string' && input.diff.includes('TODO')) {
      return { verdict: 'abstain', score: 0.5, evidence: 'mock: TODO marker in diff' };
    }
    if (
      Array.isArray(input.files) &&
      input.files.some((file) => typeof file === 'string' && file.toLowerCase().includes('protected'))
    ) {
      return { verdict: 'abstain', score: 0.5, evidence: 'mock: protected file in changeset' };
    }
    return { verdict: 'allow', score: MOCK_ALLOW_SCORE, evidence: 'mock: no risk signals' };
  }
}

/** Convenience factory, equivalent to `new MockJudge(verdictOrFn)`. */
export function makeMockJudge(verdictOrFn?: MockJudgeResponse): MockJudge {
  return new MockJudge(verdictOrFn);
}
