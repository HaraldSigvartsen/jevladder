import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPluginFiles, writePluginFiles } from '../src/plugin.js';
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

  it('hooks.json references the observe script via CLAUDE_PLUGIN_ROOT', () => {
    const files = buildPluginFiles();
    const hooks = files['hooks/hooks.json'] as string;
    expect(hooks).toContain('${CLAUDE_PLUGIN_ROOT}/scripts/jev-observe.mjs');
    expect(hooks).toContain('UserPromptSubmit');
    expect(hooks).toContain('"type": "command"');
    expect(hooks).toContain('"timeout": 5');
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
});

describe('jev plugin CLI', () => {
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
