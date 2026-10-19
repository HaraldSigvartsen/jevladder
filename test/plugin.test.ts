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
        'README.md',
        'agents/jev-cheap.md',
        'agents/jev-mid.md',
        'agents/jev-frontier.md',
        'config.json',
        'hooks/hooks.json',
        'scripts/jev-observe.mjs',
      ].sort(),
    );

    const manifest = JSON.parse(files['.claude-plugin/plugin.json'] as string) as {
      name: string;
      version: string;
      description: string;
      author: { name: string };
    };
    expect(manifest.name).toBe('jev');
    expect(manifest.version).toBe('0.2.0');
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
      const agent = files[`agents/jev-${tier}.md`];
      expect(agent).toMatch(new RegExp(`^---\\nname: jev-${tier}\\ndescription: .+\\nmodel: ${model}\\n---\\n`));
      expect(agent).toContain('advisory');
      expect(agent).toContain('human');
    }
  });

  it('applies partial model overrides without changing other tier defaults', () => {
    const files = buildPluginFiles({ subagentModels: { frontier: 'opus', cheap: 'inherit' } });
    expect(files['agents/jev-frontier.md']).toContain('model: opus');
    expect(files['agents/jev-cheap.md']).toContain('model: inherit');
    expect(files['agents/jev-mid.md']).toContain('model: sonnet');
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
    expect(hooks).toContain('${CLAUDE_PLUGIN_ROOT}/scripts/jev-observe.mjs');
    expect(hooks).toContain('UserPromptSubmit');
    expect(hooks).toContain('"type": "command"');
    expect(hooks).toContain('"timeout": 5');
  });

  it('logFileName is embedded in the observe script, config, and README', () => {
    const files = buildPluginFiles({ logFileName: 'custom.jsonl' });
    const script = files['scripts/jev-observe.mjs'] as string;
    expect(script).toContain('custom.jsonl');
    expect(script).toContain('DEFAULT_LOG_BASENAME = "custom.jsonl"');
    expect(script).not.toMatch(/DEFAULT_LOG_BASENAME = "observe\.jsonl"/);

    const config = JSON.parse(files['config.json'] as string) as { logFileName: string };
    expect(config.logFileName).toBe('custom.jsonl');
    expect(files['README.md']).toContain('~/.jev/custom.jsonl');
    expect(files['README.md']).toContain('JEV_OBSERVE_LOG');
    expect(files['README.md']).toMatch(/env.*wins|always takes priority/i);
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
    expect(weird['scripts/jev-observe.mjs']).toContain('DEFAULT_LOG_BASENAME = "x.jsonl"');
    const fallback = buildPluginFiles({ logFileName: 'not a file!!!' });
    expect(fallback['scripts/jev-observe.mjs']).toContain(
      `DEFAULT_LOG_BASENAME = "${DEFAULT_LOG_FILE}"`,
    );
  });
});

describe('jev-observe.mjs integration', () => {
  function writePlugin(): { dir: string; script: string; log: string } {
    const dir = tempDir('jev-plugin-');
    writePluginFiles(dir);
    return {
      dir,
      script: join(dir, 'scripts', 'jev-observe.mjs'),
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
      env: { ...process.env, JEV_OBSERVE_LOG: log },
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
    expect(output.hookSpecificOutput.additionalContext).toContain(`suggested subagent=jev:jev-${tier}`);
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
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('suggested subagent=jev:jev-mid');
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

  it('JEV_OBSERVE_LOG env override wins over configured logFileName', () => {
    const dir = tempDir('jev-plugin-log-');
    writePluginFiles(dir, { logFileName: 'custom.jsonl' });
    const script = join(dir, 'scripts', 'jev-observe.mjs');
    const overrideLog = join(dir, 'override-wins.jsonl');
    const result = spawnSync(process.execPath, [script], {
      input: JSON.stringify({
        prompt: 'rename helper greet to sayHello please now',
        cwd: '/tmp',
        session_id: 'env-win',
      }),
      encoding: 'utf8',
      env: { ...process.env, JEV_OBSERVE_LOG: overrideLog },
    });
    expect(result.status).toBe(0);
    const logLine = readFileSync(overrideLog, 'utf8').trim();
    expect(logLine.length).toBeGreaterThan(0);
    expect(JSON.parse(logLine).session_id).toBe('env-win');
  });
});

describe('jev plugin CLI', () => {
  it('loads plugin JSON config and lets --protected override its globs', async () => {
    const dir = tempDir('jev-cli-config-');
    const configPath = join(dir, 'input.json');
    writeFileSync(configPath, JSON.stringify({ protectedPaths: ['**/auth/**'], logFileName: 'custom.jsonl', subagentModels: { frontier: 'opus' } }));
    const { io, err } = captureIO();
    expect(await runCli(['plugin', '--out', join(dir, 'plugin'), '--config', configPath, '--protected', '*.lock'], io)).toBe(0);
    expect(err()).toBe('');
    const config = JSON.parse(readFileSync(join(dir, 'plugin/config.json'), 'utf8'));
    expect(config.protectedPaths).toEqual(['*.lock']);
    expect(config.logFileName).toBe('custom.jsonl');
    expect(readFileSync(join(dir, 'plugin/agents/jev-frontier.md'), 'utf8')).toContain('model: opus');
  });

  it.each(['null', '[]', '{', '{"subagentModels":{"cheap":"invalid"}}', '{"protectedPaths":42}', '{"logFileName":42}', '{"subagentModels":[]}'])('rejects malformed config %s', async (raw) => {
    const dir = tempDir('jev-cli-bad-config-');
    const configPath = join(dir, 'input.json');
    writeFileSync(configPath, raw);
    const { io, out } = captureIO();
    expect(await runCli(['plugin', '--out', join(dir, 'plugin'), '--config', configPath], io)).toBe(1);
    expect(out()).toBe('');
  });

  it.each([['--config'], ['--config', '--out'], ['--config', '/missing-jev-config.json']])('rejects unusable config arguments %j', async (...args) => {
    const { io } = captureIO();
    expect(await runCli(['plugin', '--out', tempDir('jev-cli-missing-'), ...args], io)).toBe(1);
  });
  it('writes files and prints paths when --out is set', async () => {
    const dir = tempDir('jev-cli-plugin-');
    const { io, out, err } = captureIO();
    const code = await runCli(['plugin', '--out', dir, '--protected', '**/auth/**'], io);
    expect(code).toBe(0);
    expect(err()).toBe('');
    expect(out()).toContain(join(dir, '.claude-plugin', 'plugin.json'));
    expect(out()).toContain(join(dir, 'scripts', 'jev-observe.mjs'));
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
    expect(out()).toContain('jev plugin --out');
  });
});
