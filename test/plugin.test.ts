import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPluginFiles,
  DEFAULT_LOG_FILE,
  sanitizeLogFileName,
  writePluginFiles,
} from '../src/plugin.js';
import { runCli } from '../src/cli.js';
import type { CliIO } from '../src/cli.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function captureIO(): { io: CliIO; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    },
    out: () => out,
    err: () => err,
  };
}

describe('buildPluginFiles', () => {
  it('emits expected keys and a parseable manifest', () => {
    const files = buildPluginFiles({ protectedPaths: ['**/payments/**'] });
    expect(Object.keys(files).sort()).toEqual(
      [
        '.claude-plugin/plugin.json',
        '.codex-plugin/plugin.json',
        '.mcp.json',
        'scripts/tierclef-mcp.mjs',
        'README.md',
        'agents/tierclef-cheap.md',
        'agents/tierclef-mid.md',
        'agents/tierclef-frontier.md',
        'config.json',
        'hooks/hooks.json',
        'scripts/tierclef-observe.mjs',
        'scripts/tierclef-hook.sh',
        'skills/tierclef-routing/SKILL.md',
      ].sort(),
    );

    const manifest = JSON.parse(files['.claude-plugin/plugin.json'] as string) as {
      name: string;
      version: string;
      description: string;
      author: { name: string };
    };
    expect(manifest.name).toBe('tierclef');
    expect(manifest.version).toBe('0.5.0');
    expect(manifest.description).toContain('observe-only');
    expect(manifest.author.name).toBe('Harald Sigvartsen');

    const config = JSON.parse(files['config.json'] as string) as {
      protectedPaths: string[];
      irreversibleActions: string[];
      observeOnly: boolean;
    };
    expect(config.protectedPaths).toEqual(['**/payments/**']);
    expect(config.irreversibleActions).toEqual(['deploy', 'migration', 'delete']);
    expect(config.observeOnly).toBe(true);
  });

  it('emits tier agents with safe defaults and advisory instructions', () => {
    const files = buildPluginFiles();
    const models = { cheap: 'haiku', mid: 'sonnet', frontier: 'inherit' };
    expect(JSON.parse(files['config.json']!).subagentModels).toEqual(models);
    for (const [tier, model] of Object.entries(models)) {
      const agent = files[`agents/tierclef-${tier}.md`];
      expect(agent).toMatch(new RegExp(`^---\\nname: tierclef-${tier}\\ndescription: .+\\nmodel: ${model}\\n---\\n`));
      expect(agent).toContain('advisory');
      expect(agent).toContain('human');
    }
  });

  it('applies partial model overrides without changing other tier defaults', () => {
    const files = buildPluginFiles({ subagentModels: { frontier: 'opus', cheap: 'inherit' } });
    expect(files['agents/tierclef-frontier.md']).toContain('model: opus');
    expect(files['agents/tierclef-cheap.md']).toContain('model: inherit');
    expect(files['agents/tierclef-mid.md']).toContain('model: sonnet');
  });

  it.each(['gpt-example', 'opus\npermissionMode: bypassPermissions', null, 42])(
    'rejects invalid model alias %j before writing files', (alias) => {
      // Simulates untyped config input without weakening the public type.
      const config = { subagentModels: { cheap: alias } } as unknown as Parameters<typeof buildPluginFiles>[0];
      expect(() => buildPluginFiles(config)).toThrow(/subagentModels/);
    },
  );

  it('hooks.json references the observe script via CLAUDE_PLUGIN_ROOT', () => {
    const files = buildPluginFiles();
    const hooks = files['hooks/hooks.json'] as string;
    expect(hooks.match(/sh \\\"\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/tierclef-hook\.sh\\\"/g)).toHaveLength(2);
    expect(hooks).toContain('SessionStart');
    expect(hooks).toContain('UserPromptSubmit');
    expect(hooks).toContain('"type": "command"');
    expect(hooks).toContain('"timeout": 5');
  });

  it('logFileName is embedded in the observe script, config, and README', () => {
    const files = buildPluginFiles({ logFileName: 'custom.jsonl' });
    const script = files['scripts/tierclef-observe.mjs'] as string;
    expect(script).toContain('custom.jsonl');
    expect(script).toContain('DEFAULT_LOG_BASENAME = "custom.jsonl"');
    expect(script).not.toMatch(/DEFAULT_LOG_BASENAME = "observe\.jsonl"/);

    const config = JSON.parse(files['config.json'] as string) as { logFileName: string };
    expect(config.logFileName).toBe('custom.jsonl');
    expect(files['README.md']).toContain('~/.tierclef/custom.jsonl');
    expect(files['README.md']).toContain('TIERCLEF_OBSERVE_LOG');
    expect(files['README.md']).toMatch(/env.*wins|always takes priority/i);
  });

  it('emits automatic routing skill with advisory safety rules', () => {
    const skill = buildPluginFiles()['skills/tierclef-routing/SKILL.md'] as string;
    expect(skill).toMatch(/^---\nname: tierclef-routing\ndescription: .*automatically.*coding tasks.*\n---/i);
    expect(skill).toContain('Codex first');
    expect(skill).toContain('tierclef_route');
    expect(skill).toContain('tierclef_explain');
    expect(skill).toContain('tierclef:tierclef-cheap');
    expect(skill).toContain('tierclef:tierclef-mid');
    expect(skill).toContain('tierclef:tierclef-frontier');
    expect(skill).toContain('uncertainty');
    expect(skill).toContain('irreversible');
    expect(skill).toContain('CI/merge');
  });

  it('sanitizeLogFileName strips path segments and falls back on weird input', () => {
    expect(sanitizeLogFileName(undefined)).toBe(DEFAULT_LOG_FILE);
    expect(sanitizeLogFileName('')).toBe(DEFAULT_LOG_FILE);
    expect(sanitizeLogFileName('  ')).toBe(DEFAULT_LOG_FILE);
    expect(sanitizeLogFileName('custom.jsonl')).toBe('custom.jsonl');
    expect(sanitizeLogFileName('/tmp/evil/custom.jsonl')).toBe('custom.jsonl');
    expect(sanitizeLogFileName('..\\..\\custom.jsonl')).toBe('custom.jsonl');
    expect(sanitizeLogFileName('..')).toBe(DEFAULT_LOG_FILE);
    expect(sanitizeLogFileName('.')).toBe(DEFAULT_LOG_FILE);
    expect(sanitizeLogFileName('weird name with spaces.jsonl')).toBe(DEFAULT_LOG_FILE);
    expect(sanitizeLogFileName('has\0null.jsonl')).toBe(DEFAULT_LOG_FILE);

    const weird = buildPluginFiles({ logFileName: '../nope/../x.jsonl' });
    expect(weird['scripts/tierclef-observe.mjs']).toContain('DEFAULT_LOG_BASENAME = "x.jsonl"');
    const fallback = buildPluginFiles({ logFileName: 'not a file!!!' });
    expect(fallback['scripts/tierclef-observe.mjs']).toContain(
      `DEFAULT_LOG_BASENAME = "${DEFAULT_LOG_FILE}"`,
    );
  });
});

describe('tierclef-observe.mjs integration', () => {
  function writePlugin(): { dir: string; script: string; log: string } {
    const dir = tempDir('tierclef-plugin-');
    writePluginFiles(dir);
    return {
      dir,
      script: join(dir, 'scripts', 'tierclef-observe.mjs'),
      log: join(dir, 'observe-test.jsonl'),
    };
  }

  function runObserve(
    script: string,
    log: string,
    stdin: string,
  ): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [script], {
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, TIERCLEF_OBSERVE_LOG: log },
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  it('risky prompt → frontier, log without full prompt text', () => {
    const { script, log } = writePlugin();
    const prompt = 'migrate payments in production and delete old table';
    const result = runObserve(
      script,
      log,
      JSON.stringify({ prompt, cwd: '/tmp/proj', session_id: 's1' }),
    );

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(out.hookSpecificOutput.additionalContext).toContain('frontier');
    expect(out.hookSpecificOutput.additionalContext).toContain('observe-only');

    const logLine = readFileSync(log, 'utf8').trim();
    expect(logLine.length).toBeGreaterThan(0);
    const entry = JSON.parse(logLine) as {
      session_id: string;
      tier: string;
      promptChars: number;
      signals: string[];
    };
    expect(entry.session_id).toBe('s1');
    expect(entry.tier).toBe('frontier');
    expect(entry.promptChars).toBe(prompt.length);
    expect(logLine).not.toContain('delete old table');
    expect(logLine).not.toContain('old table');
  });

  it('garbage stdin → exit 0, no crash, no stdout JSON', () => {
    const { script, log } = writePlugin();
    const result = runObserve(script, log, 'not-json{{{');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('SessionStart gives automatic delegation guidance without creating a log', () => {
    const { script, log } = writePlugin();
    const result = runObserve(
      script,
      log,
      JSON.stringify({ hook_event_name: 'SessionStart' }),
    );
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output.hookSpecificOutput.additionalContext).toContain('automatically delegate');
    expect(output.hookSpecificOutput.additionalContext).toContain('tierclef:tierclef-cheap');
    expect(output.hookSpecificOutput.additionalContext).toContain('tierclef:tierclef-mid');
    expect(output.hookSpecificOutput.additionalContext).toContain('tierclef:tierclef-frontier');
    expect(() => readFileSync(log, 'utf8')).toThrow();
  });

  it('launcher exits silently when node is missing from PATH', () => {
    const { dir } = writePlugin();
    const result = spawnSync('/bin/sh', [join(dir, 'scripts', 'tierclef-hook.sh')], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'fix' }),
      encoding: 'utf8',
      env: { PATH: '/nonexistent' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it.each([
    ['rename the helper function greet to sayHello in greeting.ts', 'cheap'],
    ['fix', 'mid'],
    ['migrate payments in production and delete old table', 'frontier'],
  ])('suggests the routed agent for %s without blocking or leaking text', (prompt, tier) => {
    const { script, log } = writePlugin();
    const result = runObserve(script, log, JSON.stringify({ prompt }));
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(Object.keys(output)).toEqual(['hookSpecificOutput']);
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(output.hookSpecificOutput.additionalContext).toContain(`suggested subagent=tierclef:tierclef-${tier}`);
    expect(output.hookSpecificOutput.additionalContext).toContain('advisory delegation only');
    expect(result.stdout).not.toContain(prompt);
    const entry = JSON.parse(readFileSync(log, 'utf8'));
    expect(Object.keys(entry).sort()).toEqual(['ts', 'session_id', 'cwd', 'tier', 'signals', 'promptChars'].sort());
    expect(readFileSync(log, 'utf8')).not.toContain(prompt);
  });

  it('still suggests an agent when the log cannot be written', () => {
    const { script, dir } = writePlugin();
    const result = runObserve(script, dir, JSON.stringify({ prompt: 'fix' }));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('suggested subagent=tierclef:tierclef-mid');
  });

  it('safe prompt → cheap or mid', () => {
    const { script, log } = writePlugin();
    const result = runObserve(
      script,
      log,
      JSON.stringify({
        prompt: 'rename the helper function greet to sayHello in greeting.ts',
        cwd: '/tmp',
        session_id: 's2',
      }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(out.hookSpecificOutput.additionalContext).toMatch(/tier=(cheap|mid)/);
  });

  it('TIERCLEF_OBSERVE_LOG env override wins over configured logFileName', () => {
    const dir = tempDir('tierclef-plugin-log-');
    writePluginFiles(dir, { logFileName: 'custom.jsonl' });
    const script = join(dir, 'scripts', 'tierclef-observe.mjs');
    const overrideLog = join(dir, 'override-wins.jsonl');
    const result = spawnSync(process.execPath, [script], {
      input: JSON.stringify({
        prompt: 'rename helper greet to sayHello please now',
        cwd: '/tmp',
        session_id: 'env-win',
      }),
      encoding: 'utf8',
      env: { ...process.env, TIERCLEF_OBSERVE_LOG: overrideLog },
    });
    expect(result.status).toBe(0);
    const logLine = readFileSync(overrideLog, 'utf8').trim();
    expect(logLine.length).toBeGreaterThan(0);
    expect(JSON.parse(logLine).session_id).toBe('env-win');
  });
});

describe('tierclef plugin CLI', () => {
  it('loads plugin JSON config and lets --protected override its globs', async () => {
    const dir = tempDir('tierclef-cli-config-');
    const configPath = join(dir, 'input.json');
    writeFileSync(configPath, JSON.stringify({ protectedPaths: ['**/auth/**'], logFileName: 'custom.jsonl', subagentModels: { frontier: 'opus' } }));
    const { io, err } = captureIO();
    expect(await runCli(['plugin', '--out', join(dir, 'plugin'), '--config', configPath, '--protected', '*.lock'], io)).toBe(0);
    expect(err()).toBe('');
    const config = JSON.parse(readFileSync(join(dir, 'plugin/config.json'), 'utf8'));
    expect(config.protectedPaths).toEqual(['*.lock']);
    expect(config.logFileName).toBe('custom.jsonl');
    expect(readFileSync(join(dir, 'plugin/agents/tierclef-frontier.md'), 'utf8')).toContain('model: opus');
  });

  it.each(['null', '[]', '{', '{"subagentModels":{"cheap":"invalid"}}', '{"protectedPaths":42}', '{"logFileName":42}', '{"subagentModels":[]}'])('rejects malformed config %s', async (raw) => {
    const dir = tempDir('tierclef-cli-bad-config-');
    const configPath = join(dir, 'input.json');
    writeFileSync(configPath, raw);
    const { io, out } = captureIO();
    expect(await runCli(['plugin', '--out', join(dir, 'plugin'), '--config', configPath], io)).toBe(1);
    expect(out()).toBe('');
  });

  it.each([['--config'], ['--config', '--out'], ['--config', '/missing-tierclef-config.json']])('rejects unusable config arguments %j', async (...args) => {
    const { io } = captureIO();
    expect(await runCli(['plugin', '--out', tempDir('tierclef-cli-missing-'), ...args], io)).toBe(1);
  });
  it('writes files and prints paths when --out is set', async () => {
    const dir = tempDir('tierclef-cli-plugin-');
    const { io, out, err } = captureIO();
    const code = await runCli(['plugin', '--out', dir, '--protected', '**/auth/**'], io);
    expect(code).toBe(0);
    expect(err()).toBe('');
    expect(out()).toContain(join(dir, '.claude-plugin', 'plugin.json'));
    expect(out()).toContain(join(dir, 'scripts', 'tierclef-observe.mjs'));
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
      protectedPaths: string[];
    };
    expect(config.protectedPaths).toEqual(['**/auth/**']);
  });

  it('missing --out → exit 1', async () => {
    const { io, err } = captureIO();
    const code = await runCli(['plugin'], io);
    expect(code).toBe(1);
    expect(err()).toContain('--out');
  });

  it('--help mentions plugin', async () => {
    const { io, out } = captureIO();
    const code = await runCli(['--help'], io);
    expect(code).toBe(0);
    expect(out()).toContain('tierclef plugin --out');
  });
});

describe('tierclef-mcp.mjs integration', () => {
  function runMcp(messages: unknown[], prefix = '') {
    const dir = tempDir('tierclef-mcp-');
    writePluginFiles(dir);
    const log = join(dir, 'must-not-exist.jsonl');
    const result = spawnSync(process.execPath, [join(dir, 'scripts/tierclef-mcp.mjs')], {
      input: prefix + messages.map((message) => JSON.stringify(message)).join('\n') + '\n',
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, TIERCLEF_OBSERVE_LOG: log },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(() => readFileSync(log)).toThrow();
    return result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  }
  const request = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, params });

  it('initializes, lists tools, routes production risk, explains, and survives garbage', () => {
    const task = 'migrate production payments and delete old table PRIVATE_TASK_MARKER';
    const responses = runMcp([
      request(1, 'initialize', { protocolVersion: '2025-03-26' }),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      request(2, 'tools/list'),
      request(3, 'tools/call', { name: 'tierclef_route', arguments: { task } }),
      request(4, 'tools/call', { name: 'tierclef_explain', arguments: { task } }),
      request(5, 'ping'),
    ], 'not-json{{{\nnull\n[]\n42\n{"jsonrpc":"2.0","id":null}\n');
    expect(responses.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(responses.every((r) => r.jsonrpc === '2.0')).toBe(true);
    expect(responses[0].result).toEqual({
      protocolVersion: '2025-03-26', capabilities: { tools: {} },
      serverInfo: { name: 'tierclef', version: '0.5.0' },
    });
    expect(responses[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual(['tierclef_decide', 'tierclef_route', 'tierclef_explain']);
    expect(JSON.parse(responses[2].result.content[0].text)).toEqual({ tier: 'frontier', signals: ['payments', 'migration', 'delete', 'production'] });
    expect(responses[3].result.content[0].text).toContain('irreversible actions require human review');
    expect(JSON.stringify(responses)).not.toContain('PRIVATE_TASK_MARKER');
    expect(responses[4].result).toEqual({});
  });

  it('tierclef_decide applies miniature merge rules without returning diff content', () => {
    const decide = (diff: string, extra: Record<string, unknown> = {}) => {
      const [response] = runMcp([request(1, 'tools/call', { name: 'tierclef_decide', arguments: { diff, ...extra } })]);
      return response.result;
    };
    const safeDiff = '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new';
    expect(JSON.parse(decide(safeDiff, { testsPassed: true }).content[0].text)).toMatchObject({ outcome: 'allow', source: 'judge' });
    for (const malformed of ['', '   ', '+content without file headers', '--- weird\n+++ malformed']) {
      expect(JSON.parse(decide(malformed, { testsPassed: true }).content[0].text)).toMatchObject({
        outcome: 'human', reason: 'empty or malformed diff — insufficient evidence',
      });
    }
    for (const file of ['payments/charge.ts', 'src/auth-guard.ts', 'src/session-store.ts', 'db/migrations/001.sql', 'config/secrets/key.txt']) {
      const deleted = `--- a/${file}\n+++ /dev/null\n-old`;
      expect(JSON.parse(decide(deleted, { testsPassed: true }).content[0].text)).toMatchObject({
        outcome: 'block', source: 'rule:protected-paths',
      });
    }
    // synthetic fixture assembled from pieces — do not inline
    const genericCredential = ['abcdefgh', '12345678'].join('');
    for (const body of [
      `+token: ${genericCredential}`,
      '+-----BEGIN RSA ' + 'PRIVATE KEY-----',
      `++token = ${genericCredential}`,
      `+const token = "${genericCredential}";`,
    ]) {
      // synthetic fixture assembled from pieces — do not inline
      const githubCredential = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
      const secret = `--- a/src/config.ts\n+++ b/src/config.ts\n${body}`;
      const response = decide(secret, { testsPassed: true });
      expect(JSON.parse(response.content[0].text)).toMatchObject({ outcome: 'block', source: 'rule:secrets-in-diff' });
      expect(response.content[0].text).not.toContain(genericCredential);
      expect(response.content[0].text).not.toContain(githubCredential);
    }
    // synthetic fixture assembled from pieces — do not inline
    const githubCredential = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
    const standaloneCredential = `+${githubCredential}`;
    const standaloneResult = decide(`--- a/src/config.ts\n+++ b/src/config.ts\n${standaloneCredential}`, { testsPassed: true });
    expect(JSON.parse(standaloneResult.content[0].text)).toMatchObject({ outcome: 'block', source: 'rule:secrets-in-diff' });
    expect(standaloneResult.content[0].text).not.toContain(githubCredential);
    const protectedDiff = '--- a/payments/secret.ts\n+++ b/payments/secret.ts\n+PAYMENT_PRIVATE_MARKER';
    const protectedResult = decide(protectedDiff, { testsPassed: true });
    expect(JSON.parse(protectedResult.content[0].text)).toMatchObject({ outcome: 'block', source: 'rule:protected-paths' });
    expect(protectedResult.content[0].text).not.toContain('PAYMENT_PRIVATE_MARKER');
    expect(JSON.parse(decide(safeDiff).content[0].text)).toMatchObject({ outcome: 'block', source: 'rule:tests-not-green' });
    expect(JSON.parse(decide(safeDiff, { testsPassed: true, irreversible: true }).content[0].text)).toMatchObject({ outcome: 'human', source: 'judge' });
    expect(JSON.parse(decide('+// TODO inspect later', { testsPassed: true }).content[0].text)).toMatchObject({ outcome: 'human' });
    const templateEnv = '--- a/.env.example\n+++ b/.env.example\n+API_KEY=YOUR_API_KEY_HERE';
    expect(JSON.parse(decide(templateEnv, { testsPassed: true }).content[0].text)).toMatchObject({ outcome: 'allow' });
    // synthetic fixture assembled from pieces — do not inline
    const stripeCredential = ['sk', 'live', 'ABCD1234', 'EFGH5678'].join('_');
    const secretDiff = `--- a/src/config.ts\n+++ b/src/config.ts\n+api_key = "${stripeCredential}"`;
    const secretResult = decide(secretDiff, { testsPassed: true });
    expect(JSON.parse(secretResult.content[0].text)).toMatchObject({ outcome: 'block', source: 'rule:secrets-in-diff' });
    expect(secretResult.content[0].text).not.toContain(stripeCredential);
    const dependencyDiff = '--- a/package.json\n+++ b/package.json\n@@\n+"new-package": "^1.0.0"';
    expect(JSON.parse(decide(dependencyDiff, { testsPassed: true }).content[0].text)).toMatchObject({ outcome: 'block', source: 'rule:new-dependencies' });
    const invalid = decide('', { testsPassed: 'true' });
    expect(invalid.isError).toBe(true);
  });

  it('defaults protocol version, errors on unknown methods/tools, and rejects invalid tasks', () => {
    const responses = runMcp([
      request(0, 'initialize'),
      request(1, 'unknown-method'),
      request(2, 'tools/call', { name: 'missing-tool' }),
      ...[undefined, null, 42, {}, '', '  '].map((task, index) =>
        request(index + 3, 'tools/call', { name: index % 2 ? 'tierclef_route' : 'tierclef_explain', arguments: { task } })),
      request(9, 'tools/call'),
      request(10, 'ping'),
    ]);
    expect(responses[0].result.protocolVersion).toBe('2024-11-05');
    expect(responses[1].error.code).toBe(-32601);
    for (const response of responses.slice(2, -1)) expect(response.result.isError).toBe(true);
    expect(responses.at(-1).result).toEqual({});
  });

  it.each([
    'rename the helper function greet to sayHello in greeting.ts',
    'fix',
    'migrate production payments and delete old table',
  ])('matches the observe hook miniature scorer for %s', (task) => {
    const [response] = runMcp([request(1, 'tools/call', { name: 'tierclef_route', arguments: { task } })]);
    const dir = tempDir('tierclef-parity-');
    writePluginFiles(dir);
    const observed = spawnSync(process.execPath, [join(dir, 'scripts/tierclef-observe.mjs')], {
      input: JSON.stringify({ prompt: task }), encoding: 'utf8',
      env: { ...process.env, TIERCLEF_OBSERVE_LOG: join(dir, 'observe.jsonl') },
    });
    expect(observed.status).toBe(0);
    const entry = JSON.parse(readFileSync(join(dir, 'observe.jsonl'), 'utf8'));
    expect(JSON.parse(response.result.content[0].text)).toEqual({ tier: entry.tier, signals: entry.signals });
  });
});
