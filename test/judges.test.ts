import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_JUDGE_API_KEY_ENV,
  MockJudge,
  OpenAICompatibleJudge,
  makeMockJudge,
  type GateInput,
} from '../src/index.js';

const baseInput: GateInput = { action: 'edit src/gate.ts' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MockJudge', () => {
  it('defaults to allow 0.85 with evidence "mock: no risk signals"', async () => {
    const raw = await new MockJudge().judge(baseInput);
    expect(raw).toEqual({ verdict: 'allow', score: 0.85, evidence: 'mock: no risk signals' });
  });

  it('abstains when the diff contains TODO', async () => {
    const raw = await new MockJudge().judge({ action: 'x', diff: '+ // TODO fix this later' });
    expect(raw).toMatchObject({ verdict: 'abstain' });
  });

  it('abstains when a protected file is touched', async () => {
    const raw = await new MockJudge().judge({ action: 'x', files: ['src/protected/secrets.ts'] });
    expect(raw).toMatchObject({ verdict: 'abstain' });
  });

  it('returns context.mockVerdict verbatim when present', async () => {
    const sentinel = { verdict: 'block', score: 1, evidence: 'sentinel' };
    const raw = await new MockJudge().judge({ action: 'x', context: { mockVerdict: sentinel } });
    expect(raw).toBe(sentinel);
  });

  it('makeMockJudge(fixedRaw) returns the fixed raw verbatim', async () => {
    const judge = makeMockJudge({ verdict: 'allow', score: 0.42, evidence: 'fixed' });
    expect(await judge.judge(baseInput)).toEqual({ verdict: 'allow', score: 0.42, evidence: 'fixed' });
  });

  it('makeMockJudge(null) returns null so malformed paths stay testable', async () => {
    expect(await makeMockJudge(null).judge(baseInput)).toBeNull();
  });

  it('makeMockJudge(fn) calls the function with the gate input', async () => {
    const fn = vi.fn(() => ({ verdict: 'allow', score: 0.9, evidence: 'from fn' }));
    const judge = makeMockJudge(fn);
    await judge.judge(baseInput);
    expect(fn).toHaveBeenCalledWith(baseInput);
    expect(await judge.judge(baseInput)).toEqual({ verdict: 'allow', score: 0.9, evidence: 'from fn' });
  });
});

describe('OpenAICompatibleJudge', () => {
  const config = { baseUrl: 'https://judge.example/v1', model: 'test-model' };

  function okResponse(content: string): Response {
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  function stubFetch(contentOrResponse: string | Response) {
    const fetchMock = vi.fn(
      async (_url: unknown, _init: RequestInit): Promise<Response> =>
        typeof contentOrResponse === 'string' ? okResponse(contentOrResponse) : contentOrResponse,
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('sends a chat completion and returns the parsed raw verdict', async () => {
    vi.stubEnv(DEFAULT_JUDGE_API_KEY_ENV, 'test-key');
    const fetchMock = stubFetch('{"verdict":"block","score":0.91,"evidence":"destructive sql"}');

    const raw = await new OpenAICompatibleJudge(config).judge({ action: 'run raw sql' });

    expect(raw).toEqual({ verdict: 'block', score: 0.91, evidence: 'destructive sql' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://judge.example/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body as string) as {
      model: string;
      temperature: number;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe('test-model');
    expect(body.temperature).toBe(0);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('JSON');
    expect(JSON.parse(body.messages[1].content)).toMatchObject({ action: 'run raw sql' });
  });

  it('strips code fences before parsing', async () => {
    vi.stubEnv(DEFAULT_JUDGE_API_KEY_ENV, 'test-key');
    stubFetch('```json\n{"verdict":"allow","score":0.88,"evidence":"fenced"}\n```');

    const raw = await new OpenAICompatibleJudge(config).judge(baseInput);

    expect(raw).toEqual({ verdict: 'allow', score: 0.88, evidence: 'fenced' });
  });

  it('missing API key returns an abstain-like raw without calling fetch', async () => {
    vi.stubEnv(DEFAULT_JUDGE_API_KEY_ENV, '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const raw = await new OpenAICompatibleJudge(config).judge(baseInput);

    expect(raw).toMatchObject({ verdict: 'abstain' });
    expect((raw as { evidence: string }).evidence).toContain(DEFAULT_JUDGE_API_KEY_ENV);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honours a custom apiKeyEnv', async () => {
    vi.stubEnv('OTHER_JUDGE_KEY', 'other-key');
    vi.stubEnv(DEFAULT_JUDGE_API_KEY_ENV, '');
    const fetchMock = stubFetch('{"verdict":"allow","score":0.8,"evidence":"ok"}');

    await new OpenAICompatibleJudge({ ...config, apiKeyEnv: 'OTHER_JUDGE_KEY' }).judge(baseInput);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer other-key');
  });

  it('non-JSON content returns an abstain-like raw', async () => {
    vi.stubEnv(DEFAULT_JUDGE_API_KEY_ENV, 'test-key');
    stubFetch('I think this is fine, let me say allow.');

    const raw = await new OpenAICompatibleJudge(config).judge(baseInput);

    expect(raw).toMatchObject({ verdict: 'abstain' });
    expect((raw as { evidence: string }).evidence).toContain('not valid JSON');
  });

  it('HTTP errors return an abstain-like raw', async () => {
    vi.stubEnv(DEFAULT_JUDGE_API_KEY_ENV, 'test-key');
    stubFetch(new Response('server error', { status: 500 }));

    const raw = await new OpenAICompatibleJudge(config).judge(baseInput);

    expect(raw).toEqual({ verdict: 'abstain', score: 0, evidence: 'judge HTTP 500' });
  });

  it('network failures return an abstain-like raw instead of throwing', async () => {
    vi.stubEnv(DEFAULT_JUDGE_API_KEY_ENV, 'test-key');
    const fetchMock = vi.fn(async (_url: unknown, _init: RequestInit): Promise<Response> => {
      throw new Error('connection refused');
    });
    vi.stubGlobal('fetch', fetchMock);

    const raw = await new OpenAICompatibleJudge(config).judge(baseInput);

    expect(raw).toMatchObject({ verdict: 'abstain' });
    expect((raw as { evidence: string }).evidence).toContain('connection refused');
  });

  it('requires baseUrl and model at construction time', () => {
    expect(() => new OpenAICompatibleJudge({ baseUrl: '', model: 'm' })).toThrow(TypeError);
    expect(() => new OpenAICompatibleJudge({ baseUrl: 'https://x', model: '' })).toThrow(TypeError);
  });

  it('has no implicit vendor model; empty or missing configuration is rejected', () => {
    expect(() => new OpenAICompatibleJudge({ baseUrl: 'https://judge.example/v1', model: '' })).toThrow(/model is required/);
    expect(() => new OpenAICompatibleJudge({ baseUrl: 'https://judge.example/v1' } as never)).toThrow(/model is required/);
  });
});
