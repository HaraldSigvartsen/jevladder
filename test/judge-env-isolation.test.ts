import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TypeSafeJudge,
  OpenAICompatibleJudge,
  DEFAULT_JUDGE_API_KEY_ENV,
  TYPESAFE_SYSTEMONE_URL,
  JEVLADDER_TYPESAFE_API_KEY_ENV,
  TYPESAFE_API_KEY_ENV,
  buildPluginFiles,
  writePluginFiles,
  type GateInput,
} from '../src/index.js';

const baseInput: GateInput = {
  action: 'merge',
  diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new',
  files: ['src/a.ts'],
};

const openAiConfig = { baseUrl: 'https://judge.example/v1', model: 'test-model' };
const preload = resolve('test/fixtures/preload-fetch-stub.mjs');

function runtimeFakeKey(tag: string): string {
  return ['ts', tag, String(Date.now())].join('_');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('judge API key env isolation', () => {
  it('TypeSafe abstains with no fetch when only JEVLADDER_JUDGE_API_KEY is set', async () => {
    const openAiOnlyKey = runtimeFakeKey('openai');
    vi.stubEnv(DEFAULT_JUDGE_API_KEY_ENV, openAiOnlyKey);
    vi.stubEnv(JEVLADDER_TYPESAFE_API_KEY_ENV, '');
    vi.stubEnv(TYPESAFE_API_KEY_ENV, '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const raw = await new TypeSafeJudge({ userAgentVersion: '0.6.0' }).judge(baseInput);

    expect(raw).toMatchObject({ verdict: 'abstain', evidence: 'no judge key configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('OpenAI-compatible abstains with no fetch when only TypeSafe env keys are set', async () => {
    const typesafeKey = runtimeFakeKey('typesafe');
    vi.stubEnv(DEFAULT_JUDGE_API_KEY_ENV, '');
    vi.stubEnv(JEVLADDER_TYPESAFE_API_KEY_ENV, typesafeKey);
    vi.stubEnv(TYPESAFE_API_KEY_ENV, '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const raw = await new OpenAICompatibleJudge(openAiConfig).judge(baseInput);

    expect(raw).toMatchObject({ verdict: 'abstain' });
    expect((raw as { evidence: string }).evidence).toContain(DEFAULT_JUDGE_API_KEY_ENV);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('each judge sends only its own key when both provider env families are set', async () => {
    const typesafeKey = runtimeFakeKey('ts');
    const openAiKey = runtimeFakeKey('oa');
    vi.stubEnv(JEVLADDER_TYPESAFE_API_KEY_ENV, typesafeKey);
    vi.stubEnv(TYPESAFE_API_KEY_ENV, '');
    vi.stubEnv(DEFAULT_JUDGE_API_KEY_ENV, openAiKey);

    const tsFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          answers: { verdict: { choice: 'approve', confidence: 0.9 } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await new TypeSafeJudge({
      userAgentVersion: '0.6.0',
      fetchImpl: tsFetch,
    }).judge(baseInput);
    expect(tsFetch).toHaveBeenCalledTimes(1);
    const [tsUrl, tsInit] = tsFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(tsUrl)).toBe(TYPESAFE_SYSTEMONE_URL);
    expect((tsInit.headers as Record<string, string>).Authorization).toBe(`Bearer ${typesafeKey}`);
    expect(JSON.stringify(tsInit)).not.toContain(openAiKey);

    const oaFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '{"verdict":"allow","score":0.8,"evidence":"ok"}' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', oaFetch);
    await new OpenAICompatibleJudge(openAiConfig).judge(baseInput);
    expect(oaFetch).toHaveBeenCalledTimes(1);
    const [oaUrl, oaInit] = oaFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(oaUrl).toBe('https://judge.example/v1/chat/completions');
    expect((oaInit.headers as Record<string, string>).authorization).toBe(`Bearer ${openAiKey}`);
    expect(JSON.stringify(oaInit)).not.toContain(typesafeKey);
  });

  it('rejects wiring OpenAICompatibleJudge to a TypeSafe credential env', () => {
    expect(() => new OpenAICompatibleJudge({ ...openAiConfig, apiKeyEnv: 'TYPESAFE_API_KEY' })).toThrow(
      /TypeSafe credential/,
    );
  });
});

describe('generated MCP script env isolation', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop() as string, { recursive: true, force: true });
    }
  });

  it('resolveJudgeApiKey in emitted script uses TypeSafe env vars only', () => {
    const script = buildPluginFiles()['scripts/jevladder-mcp.mjs'] as string;
    expect(script).toContain('JEVLADDER_TYPESAFE_API_KEY');
    expect(script).not.toMatch(/process\.env\.JEVLADDER_JUDGE_API_KEY/);
  });

  it('committed plugin/scripts/jevladder-mcp.mjs matches buildPluginFiles output', () => {
    const generated = buildPluginFiles()['scripts/jevladder-mcp.mjs'];
    const committed = readFileSync(resolve('plugin/scripts/jevladder-mcp.mjs'), 'utf8');
    expect(committed).toBe(generated);
  });

  it('MCP decide ignores JEVLADDER_JUDGE_API_KEY (no fetch)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-mcp-env-'));
    tempDirs.push(dir);
    writePluginFiles(dir);
    const openAiOnlyKey = runtimeFakeKey('mcp-openai');
    const fetchLog = join(dir, 'fetch.log');
    const result = spawnSync(
      process.execPath,
      ['--import', preload, join(dir, 'scripts/jevladder-mcp.mjs')],
      {
        input: `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'jevladder_decide',
            arguments: { diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new', testsPassed: true },
          },
        })}\n`,
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          JEVLADDER_JUDGE_API_KEY: openAiOnlyKey,
          JEVLADDER_TYPESAFE_API_KEY: '',
          TYPESAFE_API_KEY: '',
          JEVLADDER_TEST_FETCH_LOG: fetchLog,
        },
      },
    );
    expect(result.status).toBe(0);
    const line = JSON.parse(result.stdout.trim()) as { result: { content: { text: string }[] } };
    expect(JSON.parse(line.result.content[0].text)).toMatchObject({
      outcome: 'human',
      reason: 'no judge key configured',
    });
    expect(result.stdout).not.toContain(openAiOnlyKey);
    expect(() => readFileSync(fetchLog, 'utf8')).toThrow();
  });

  it('MCP decide sends only the TypeSafe key to api.typesafe.ai when configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-mcp-ts-'));
    tempDirs.push(dir);
    writePluginFiles(dir);
    const typesafeKey = runtimeFakeKey('mcp-ts');
    const openAiKey = runtimeFakeKey('mcp-oa-leak');
    const fetchLog = join(dir, 'fetch.log');
    const result = spawnSync(
      process.execPath,
      ['--import', preload, join(dir, 'scripts/jevladder-mcp.mjs')],
      {
        input: `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'jevladder_decide',
            arguments: { diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new', testsPassed: true },
          },
        })}\n`,
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          JEVLADDER_JUDGE_API_KEY: openAiKey,
          JEVLADDER_TYPESAFE_API_KEY: typesafeKey,
          TYPESAFE_API_KEY: '',
          JEVLADDER_TEST_FETCH_LOG: fetchLog,
        },
      },
    );
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as { result: { content: { text: string }[] } };
    expect(JSON.parse(payload.result.content[0].text)).toMatchObject({ outcome: 'allow', source: 'judge' });
    const logLines = readFileSync(fetchLog, 'utf8').trim().split('\n');
    expect(logLines).toHaveLength(1);
    const call = JSON.parse(logLines[0]) as { url: string; headers: Record<string, string>; body: string };
    expect(call.url).toBe(TYPESAFE_SYSTEMONE_URL);
    expect(call.headers.Authorization).toBe(`Bearer ${typesafeKey}`);
    expect(call.body).not.toContain(openAiKey);
    expect(JSON.stringify(call)).not.toContain(openAiKey);
  });
});
