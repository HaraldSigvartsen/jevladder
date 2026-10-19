import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import type { CliIO } from '../src/cli.js';

const SAFE_DIFF = [
  'diff --git a/src/greeting.ts b/src/greeting.ts',
  '--- a/src/greeting.ts',
  '+++ b/src/greeting.ts',
  '@@ -1,3 +1,3 @@',
  ' export function greet(name: string): string {',
  "-  return 'Hello, ' + name + '!';",
  "+  return 'Hello, ' + name + '! Welcome back.';",
  ' }',
  '',
].join('\n');

const RISKY_PAYMENTS_DIFF = [
  'diff --git a/src/payments/charge.ts b/src/payments/charge.ts',
  '--- a/src/payments/charge.ts',
  '+++ b/src/payments/charge.ts',
  '@@ -2,6 +2,7 @@ import { computeFee } from "./fees.js";',
  ' export function charge(amountCents: number): number {',
  '   const feeCents = computeFee(amountCents);',
  '+  password = "FAKE_EXAMPLE_ONLY_123";',
  '   return submitCharge(amountCents + feeCents);',
  ' }',
  '',
].join('\n');

const RISKY_SECRET_DIFF = [
  'diff --git a/src/config.ts b/src/config.ts',
  '--- a/src/config.ts',
  '+++ b/src/config.ts',
  '@@ -1,3 +1,4 @@',
  ' export const app = {',
  '+  password = "FAKE_EXAMPLE_ONLY_123";',
  '   retries: 3,',
  ' };',
  '',
].join('\n');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function writeTempDiff(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-cli-'));
  tempDirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, content, 'utf8');
  return file;
}

function captureIO(stdin?: string): { io: CliIO; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  const io: CliIO = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    ...(stdin !== undefined ? { readStdin: () => stdin } : {}),
  };
  return { io, out: () => out, err: () => err };
}

describe('jev check', () => {
  it('allows a small safe diff with green tests (exit 0, judge source)', async () => {
    const file = writeTempDiff('safe.diff', SAFE_DIFF);
    const { io, out } = captureIO();
    const code = await runCli(['check', '--diff', file, '--tests-passed'], io);
    expect(code).toBe(0);
    expect(out()).toContain('allow');
    expect(out()).toContain('judge');
    expect(out()).toContain('mock: no risk signals');
  });

  it('blocks a payments diff (exit 2, protected path decides first)', async () => {
    const file = writeTempDiff('risky.diff', RISKY_PAYMENTS_DIFF);
    const { io, out } = captureIO();
    const code = await runCli(['check', '--diff', file, '--tests-passed'], io);
    expect(code).toBe(2);
    expect(out()).toContain('block');
    expect(out()).toContain('protected-paths');
    expect(out()).toContain('src/payments/charge.ts');
  });

  it('blocks a fake secret outside protected paths (exit 2, secrets-in-diff)', async () => {
    const file = writeTempDiff('secret.diff', RISKY_SECRET_DIFF);
    const { io, out } = captureIO();
    const code = await runCli(['check', '--diff', file, '--tests-passed'], io);
    expect(code).toBe(2);
    expect(out()).toContain('block');
    expect(out()).toContain('secrets-in-diff');
  });

  it('blocks when tests are failed', async () => {
    const file = writeTempDiff('safe.diff', SAFE_DIFF);
    const { io, out } = captureIO();
    const code = await runCli(['check', '--diff', file, '--tests-failed'], io);
    expect(code).toBe(2);
    expect(out()).toContain('tests-not-green');
  });

  it('blocks when test status is unspecified (never fail open)', async () => {
    const file = writeTempDiff('safe.diff', SAFE_DIFF);
    const { io, out } = captureIO();
    const code = await runCli(['check', '--diff', file], io);
    expect(code).toBe(2);
    expect(out()).toContain('tests not green');
  });

  it('routes an irreversible judge-allow to a human (exit 3)', async () => {
    const file = writeTempDiff('safe.diff', SAFE_DIFF);
    const { io, out } = captureIO();
    const code = await runCli(
      ['check', '--diff', file, '--tests-passed', '--irreversible'],
      io,
    );
    expect(code).toBe(3);
    expect(out()).toContain('human');
  });

  it('prints parseable JSON with --json', async () => {
    const file = writeTempDiff('safe.diff', SAFE_DIFF);
    const { io, out } = captureIO();
    const code = await runCli(['check', '--diff', file, '--tests-passed', '--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out()) as { outcome: string; source: string };
    expect(parsed.outcome).toBe('allow');
    expect(parsed.source).toBe('judge');
  });

  it('reads the diff from stdin with --diff -', async () => {
    const { io, out } = captureIO(SAFE_DIFF);
    const code = await runCli(['check', '--diff', '-', '--tests-passed'], io);
    expect(code).toBe(0);
    expect(out()).toContain('allow');
  });

  it('usage-errors on an unknown option (exit 1, stderr)', async () => {
    const { io, err } = captureIO();
    const code = await runCli(['check', '--nope'], io);
    expect(code).toBe(1);
    expect(err()).toContain('--nope');
  });

  it('usage-errors on conflicting test flags', async () => {
    const file = writeTempDiff('safe.diff', SAFE_DIFF);
    const { io, err } = captureIO();
    const code = await runCli(
      ['check', '--diff', file, '--tests-passed', '--tests-failed'],
      io,
    );
    expect(code).toBe(1);
    expect(err()).toContain('mutually exclusive');
  });

  it('returns 1 when the diff file cannot be read', async () => {
    const { io, err } = captureIO();
    const code = await runCli(
      ['check', '--diff', '/nonexistent/jev-cli-test.diff', '--tests-passed'],
      io,
    );
    expect(code).toBe(1);
    expect(err()).toContain('cannot read');
  });
});

describe('jev route', () => {
  it('routes a docs typo to cheap', async () => {
    const { io, out } = captureIO();
    const code = await runCli(['route', '--explain', 'Rename a typo in the docs'], io);
    expect(code).toBe(0);
    expect(out()).toContain('cheap');
    expect(out()).toContain('explanation:');
  });

  it('prints parseable JSON with --json', async () => {
    const { io, out } = captureIO();
    const code = await runCli(
      ['route', '--explain', 'Rename a typo in the docs', '--json'],
      io,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out()) as { tier: string; abstained: boolean };
    expect(parsed.tier).toBe('cheap');
    expect(parsed.abstained).toBe(false);
  });

  it('usage-errors without --explain', async () => {
    const { io, err } = captureIO();
    const code = await runCli(['route'], io);
    expect(code).toBe(1);
    expect(err()).toContain('--explain');
  });
});

describe('jev top-level', () => {
  it('prints the version (exit 0)', async () => {
    const { io, out } = captureIO();
    const code = await runCli(['--version'], io);
    expect(code).toBe(0);
    expect(out()).toMatch(/^\d+\.\d+\.\d+\s*$/);
  });

  it('prints help with --help (exit 0)', async () => {
    const { io, out } = captureIO();
    const code = await runCli(['--help'], io);
    expect(code).toBe(0);
    expect(out()).toContain('Usage');
  });

  it('prints usage to stderr and exits 1 with no command', async () => {
    const { io, err } = captureIO();
    const code = await runCli([], io);
    expect(code).toBe(1);
    expect(err()).toContain('Usage');
  });

  it('usage-errors on unknown commands (exit 1, stderr)', async () => {
    const { io, err } = captureIO();
    const code = await runCli(['frobnicate'], io);
    expect(code).toBe(1);
    expect(err()).toContain('unknown command "frobnicate"');
  });
});
