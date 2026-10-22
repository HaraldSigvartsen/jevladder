/**
 * TypeSafe System One judge adapter (`choice` primitive). Injectable fetch for
 * tests; never throws; operational failures abstain (human at the gate).
 */
import type { GateInput, Judge } from '../gate.js';
import { buildTypeSafeJudgeState } from './diff-summary.js';

export const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_JUDGE_MODEL = 'jev-1.13.0';
export const JEVLADDER_TYPESAFE_API_KEY_ENV = 'JEVLADDER_TYPESAFE_API_KEY';
export const TYPESAFE_API_KEY_ENV = 'TYPESAFE_API_KEY';
export const DEFAULT_TYPESAFE_MIN_CONFIDENCE = 0.6;
export const DEFAULT_TYPESAFE_TIMEOUT_MS = 8_000;

const VERDICT_QUESTION =
  'Should this proposed merge proceed after deterministic safety rules have already passed?';

const CRITERIA_APPROVE =
  'Routine, low-risk code change with no signs of credential exposure, auth bypass, or incomplete work.';

const CRITERIA_ESCALATE =
  'Any uncertainty, security-sensitive semantics, incomplete change, or need for human review.';

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TypeSafeJudgeConfig {
  /** Package version for User-Agent. */
  userAgentVersion: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  minConfidence?: number;
  /** Override env lookup (tests). */
  resolveApiKey?: () => string | undefined;
}

function abstain(evidence: string): unknown {
  return { verdict: 'abstain', score: 0, evidence };
}

function errClass(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

export function resolveJudgeApiKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const primary = env[JEVLADDER_TYPESAFE_API_KEY_ENV];
  if (typeof primary === 'string' && primary.trim() !== '') return primary.trim();
  const fallback = env[TYPESAFE_API_KEY_ENV];
  if (typeof fallback === 'string' && fallback.trim() !== '') return fallback.trim();
  return undefined;
}

/** Fail-closed judge when no API key is configured (CLI / default wiring). */
export class NoKeyConfiguredJudge implements Judge {
  async judge(_input: GateInput): Promise<unknown> {
    return abstain('no judge key configured');
  }
}

export class TypeSafeJudge implements Judge {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly minConfidence: number;
  private readonly userAgentVersion: string;
  private readonly resolveApiKey: () => string | undefined;

  constructor(config: TypeSafeJudgeConfig) {
    if (!config?.userAgentVersion || config.userAgentVersion.trim() === '') {
      throw new TypeError('TypeSafeJudge: userAgentVersion is required');
    }
    this.userAgentVersion = config.userAgentVersion.trim();
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs =
      typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
        ? config.timeoutMs
        : DEFAULT_TYPESAFE_TIMEOUT_MS;
    this.minConfidence =
      typeof config.minConfidence === 'number' &&
      Number.isFinite(config.minConfidence) &&
      config.minConfidence > 0 &&
      config.minConfidence <= 1
        ? config.minConfidence
        : DEFAULT_TYPESAFE_MIN_CONFIDENCE;
    this.resolveApiKey = config.resolveApiKey ?? (() => resolveJudgeApiKey());
  }

  async judge(input: GateInput): Promise<unknown> {
    if (typeof input.diff === 'string' && input.diff.includes('TODO')) {
      return abstain('typesafe: TODO marker in diff');
    }
    if (input.irreversible === true) {
      return abstain('typesafe: irreversible action requires human review');
    }

    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      return abstain('no judge key configured');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(TYPESAFE_SYSTEMONE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': `jevladder/${this.userAgentVersion}`,
        },
        body: JSON.stringify({
          model: TYPESAFE_JUDGE_MODEL,
          state: buildTypeSafeJudgeState(input),
          questions: {
            verdict: {
              type: 'choice',
              instructions: VERDICT_QUESTION,
              criteria: {
                approve: CRITERIA_APPROVE,
                escalate: CRITERIA_ESCALATE,
              },
            },
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        return abstain('timeout');
      }
      return abstain(`judge request failed: ${errClass(err)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return abstain(`HTTP ${response.status}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return abstain('malformed JSON');
    }

    if (typeof data !== 'object' || data === null) {
      return abstain('malformed response');
    }
    const answers = (data as Record<string, unknown>).answers;
    if (typeof answers !== 'object' || answers === null) {
      return abstain('malformed response');
    }
    const verdict = (answers as Record<string, unknown>).verdict;
    if (typeof verdict !== 'object' || verdict === null) {
      return abstain('malformed response');
    }
    const choice = (verdict as Record<string, unknown>).choice;
    const confidence = (verdict as Record<string, unknown>).confidence;
    if (choice !== 'approve' && choice !== 'escalate') {
      return abstain('unknown choice');
    }
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
      return abstain('malformed response');
    }

    if (choice === 'escalate' || confidence < this.minConfidence) {
      return abstain(`typesafe: ${choice} (confidence ${confidence})`);
    }

    return {
      verdict: 'allow',
      score: confidence,
      evidence: `typesafe: approve (confidence ${confidence})`,
    };
  }
}

/** Default CLI wiring: TypeSafe when a key exists, otherwise fail-closed abstain. */
export function createDefaultJudge(options: {
  userAgentVersion: string;
  fetchImpl?: FetchLike;
}): Judge {
  if (resolveJudgeApiKey()) {
    return new TypeSafeJudge({
      userAgentVersion: options.userAgentVersion,
      fetchImpl: options.fetchImpl,
    });
  }
  return new NoKeyConfiguredJudge();
}
