import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TypeSafeJudge,
  NoKeyConfiguredJudge,
  createDefaultJudge,
  resolveJudgeApiKey,
  TYPESAFE_SYSTEMONE_URL,
  TYPESAFE_JUDGE_MODEL,
  JEVLADDER_JUDGE_API_KEY_ENV,
  TYPESAFE_API_KEY_ENV,
  buildCompactDiffSummary,
  defineGate,
  makeMergeRules,
  type GateInput,
} from '../src/index.js';

const fakeKey = ['ts', 'test', 'x'.repeat(8)].join('_');

function systemOneResponse(choice: string, confidence: number): Response {
  return new Response(
    JSON.stringify({
      answers: { verdict: { choice, confidence, probabilities: { approve: 0.5, escalate: 0.5 } } },
      usage: { input_tokens: 12 },
      model: TYPESAFE_JUDGE_MODEL,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const baseInput: GateInput = {
  action: 'merge',
  diff: [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n'),
  files: ['src/a.ts'],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('TypeSafeJudge', () => {
  function stubFetch(response: Response | (() => Promise<Response>)) {
    const fetchMock = vi.fn(async () => (typeof response === 'function' ? await response() : response));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('approves when choice is approve with sufficient confidence', async () => {
    const fetchMock = stubFetch(systemOneResponse('approve', 0.91));
    const judge = new TypeSafeJudge({
      userAgentVersion: '1.2.3',
      resolveApiKey: () => fakeKey,
    });
    const raw = await judge.judge(baseInput);
    expect(raw).toEqual({
      verdict: 'allow',
      score: 0.91,
      evidence: 'typesafe: approve (confidence 0.91)',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TYPESAFE_SYSTEMONE_URL);
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('jevladder/1.2.3');
    const body = JSON.parse(init.body as string) as { model: string; state: Record<string, unknown> };
    expect(body.model).toBe(TYPESAFE_JUDGE_MODEL);
    expect(body.state.linesAdded).toBe(1);
    expect(body.state.files).toEqual(['src/a.ts']);
  });

  it('abstains on escalate choice', async () => {
    stubFetch(systemOneResponse('escalate', 0.95));
    const raw = await new TypeSafeJudge({
      userAgentVersion: '0.6.0',
      resolveApiKey: () => fakeKey,
    }).judge(baseInput);
    expect(raw).toMatchObject({ verdict: 'abstain' });
    expect((raw as { evidence: string }).evidence).toContain('escalate');
  });

  it('abstains when confidence is below threshold', async () => {
    stubFetch(systemOneResponse('approve', 0.4));
    const raw = await new TypeSafeJudge({
      userAgentVersion: '0.6.0',
      resolveApiKey: () => fakeKey,
    }).judge(baseInput);
    expect(raw).toMatchObject({ verdict: 'abstain' });
  });

  it('abstains on HTTP errors without response bodies in evidence', async () => {
    stubFetch(new Response('secret body', { status: 401 }));
    const raw = await new TypeSafeJudge({
      userAgentVersion: '0.6.0',
      resolveApiKey: () => fakeKey,
    }).judge(baseInput);
    expect(raw).toEqual({ verdict: 'abstain', score: 0, evidence: 'HTTP 401' });
    expect(JSON.stringify(raw)).not.toContain(fakeKey);
    expect(JSON.stringify(raw)).not.toContain('secret body');
  });

  it('abstains on timeout', async () => {
    stubFetch(
      () =>
        new Promise<Response>((_resolve, reject) => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }),
    );
    const raw = await new TypeSafeJudge({
      userAgentVersion: '0.6.0',
      timeoutMs: 5,
      resolveApiKey: () => fakeKey,
    }).judge(baseInput);
    expect(raw).toEqual({ verdict: 'abstain', score: 0, evidence: 'timeout' });
  });

  it('abstains on malformed JSON', async () => {
    stubFetch(new Response('not-json', { status: 200 }));
    const raw = await new TypeSafeJudge({
      userAgentVersion: '0.6.0',
      resolveApiKey: () => fakeKey,
    }).judge(baseInput);
    expect(raw).toMatchObject({ verdict: 'abstain', evidence: 'malformed JSON' });
  });

  it('abstains on unknown choice', async () => {
    stubFetch(systemOneResponse('maybe', 0.9));
    const raw = await new TypeSafeJudge({
      userAgentVersion: '0.6.0',
      resolveApiKey: () => fakeKey,
    }).judge(baseInput);
    expect(raw).toEqual({ verdict: 'abstain', score: 0, evidence: 'unknown choice' });
  });

  it('without a key abstains and never calls fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const raw = await new NoKeyConfiguredJudge().judge(baseInput);
    expect(raw).toEqual({ verdict: 'abstain', score: 0, evidence: 'no judge key configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prefers JEVLADDER_JUDGE_API_KEY over TYPESAFE_API_KEY', async () => {
    vi.stubEnv(JEVLADDER_JUDGE_API_KEY_ENV, 'jev-key');
    vi.stubEnv(TYPESAFE_API_KEY_ENV, 'ts-key');
    const fetchMock = stubFetch(systemOneResponse('approve', 0.9));
    await new TypeSafeJudge({ userAgentVersion: '0.6.0' }).judge(baseInput);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jev-key');
    expect(JSON.stringify(init)).not.toContain('ts-key');
  });

  it('truncates large diffs in the payload', async () => {
    const hugeLine = '+' + 'z'.repeat(5000);
    const diff = ['diff --git a/h.ts b/h.ts', '--- a/h.ts', '+++ b/h.ts', hugeLine].join('\n');
    const fetchMock = stubFetch(systemOneResponse('approve', 0.88));
    await new TypeSafeJudge({
      userAgentVersion: '0.6.0',
      resolveApiKey: () => fakeKey,
    }).judge({ action: 'merge', diff });
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(2500);
    expect(JSON.stringify(body)).not.toContain('z'.repeat(5000));
  });

  it('never leaks the API key into evidence', async () => {
    stubFetch(systemOneResponse('approve', 0.9));
    const raw = await new TypeSafeJudge({
      userAgentVersion: '0.6.0',
      resolveApiKey: () => fakeKey,
    }).judge(baseInput);
    expect(JSON.stringify(raw)).not.toContain(fakeKey);
  });

  it('createDefaultJudge uses TypeSafe when any key env is set', () => {
    vi.stubEnv(JEVLADDER_JUDGE_API_KEY_ENV, fakeKey);
    expect(createDefaultJudge({ userAgentVersion: '0.6.0' })).toBeInstanceOf(TypeSafeJudge);
    vi.stubEnv(JEVLADDER_JUDGE_API_KEY_ENV, '');
    vi.stubEnv(TYPESAFE_API_KEY_ENV, fakeKey);
    expect(createDefaultJudge({ userAgentVersion: '0.6.0' })).toBeInstanceOf(TypeSafeJudge);
    vi.stubEnv(TYPESAFE_API_KEY_ENV, '');
    expect(createDefaultJudge({ userAgentVersion: '0.6.0' })).toBeInstanceOf(NoKeyConfiguredJudge);
  });

  it('pre-filters TODO and irreversible before calling the model', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const judge = new TypeSafeJudge({
      userAgentVersion: '0.6.0',
      resolveApiKey: () => fakeKey,
    });
    await judge.judge({ ...baseInput, diff: `${baseInput.diff}\n+// TODO fix` });
    await judge.judge({ ...baseInput, irreversible: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('merge rules block protected paths before the model is called', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const gate = defineGate({
      rules: makeMergeRules(),
      judge: new TypeSafeJudge({
        userAgentVersion: '0.6.0',
        resolveApiKey: () => fakeKey,
      }),
    });
    const paymentsDiff = [
      'diff --git a/src/payments/x.ts b/src/payments/x.ts',
      '--- a/src/payments/x.ts',
      '+++ b/src/payments/x.ts',
      '+safe looking change',
    ].join('\n');
    const decision = await gate.decide({
      action: 'merge',
      diff: paymentsDiff,
      files: ['src/payments/x.ts'],
      context: { testsPassed: true },
    });
    expect(decision.outcome).toBe('block');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('buildCompactDiffSummary', () => {
  it('counts added and removed lines', () => {
    const summary = buildCompactDiffSummary(baseInput.diff as string);
    expect(summary.linesAdded).toBe(1);
    expect(summary.linesRemoved).toBe(1);
    expect(summary.files).toContain('src/a.ts');
  });
});

describe('resolveJudgeApiKey', () => {
  it('returns undefined when both env vars are empty', () => {
    expect(resolveJudgeApiKey({ JEVLADDER_JUDGE_API_KEY: '', TYPESAFE_API_KEY: '' })).toBeUndefined();
  });
});
