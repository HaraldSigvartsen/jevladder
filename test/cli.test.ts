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

const BINARY_ASSET_DIFF = [
  'diff --git a/src/assets/logo.png b/src/assets/logo.png',
  'index 1234567..89abcde 100644',
  'Binary files a/src/assets/logo.png and b/src/assets/logo.png differ',
  '',
].join('\n');

const BINARY_PAYMENTS_DIFF = [
  'diff --git a/src/payments/logo.png b/src/payments/logo.png',
  'index 1234567..89abcde 100644',
  'Binary files a/src/payments/logo.png and b/src/payments/logo.png differ',
  '',
].join('\n');

const RENAME_AWAY_FROM_PAYMENTS_DIFF = [
  'diff --git a/src/payments/charge.ts b/src/billing/charge.ts',
  'similarity index 100%',
  'rename from src/payments/charge.ts',
  'rename to src/billing/charge.ts',
  '',
].join('\n');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function writeTempDiff(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'jevladder-cli-'));
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

describe('jevladder check', () => {
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
      ['check', '--diff', '/nonexistent/jevladder-cli-test.diff', '--tests-passed'],
      io,
    );
    expect(code).toBe(1);
    expect(err()).toContain('cannot read');
  });

  it('fails closed on an empty diff file (B1: never an implicit allow)', async () => {
    const file = writeTempDiff('empty.diff', '');
    const { io, err } = captureIO();
    const code = await runCli(['check', '--diff', file, '--tests-passed'], io);
    expect(code).toBe(1);
    expect(err()).toContain('diff is empty');
  });

  it('fails closed on non-diff garbage input (B1)', async () => {
    const file = writeTempDiff('garbage.diff', 'just some text\nthat is not a diff at all\n');
    const { io, err } = captureIO();
    const code = await runCli(['check', '--diff', file, '--tests-passed'], io);
    expect(code).toBe(1);
    expect(err()).toContain('does not look like a unified diff');
  });

  it('fails closed on empty or garbage stdin (B1)', async () => {
    const empty = captureIO('   \n');
    expect(await runCli(['check', '--tests-passed'], empty.io)).toBe(1);
    expect(empty.err()).toContain('diff is empty');

    const garbage = captureIO('hello world, definitely not a diff');
    expect(await runCli(['check', '--tests-passed'], garbage.io)).toBe(1);
    expect(garbage.err()).toContain('does not look like a unified diff');
  });

  it('surfaces stdin read failures instead of coercing them to an empty diff (B1)', async () => {
    const errLines: string[] = [];
    const failing: CliIO = {
      stdout: () => {},
      stderr: (text) => {
        errLines.push(text);
      },
      readStdin: () => {
        throw new Error('EAGAIN: resource temporarily unavailable');
      },
    };
    const code = await runCli(['check', '--tests-passed'], failing);
    expect(code).toBe(1);
    expect(errLines.join('')).toContain('cannot read diff from stdin');
    expect(errLines.join('')).toContain('EAGAIN');
  });

  it('usage-errors when --diff value looks like another flag', async () => {
    const { io, err } = captureIO();
    const code = await runCli(['check', '--diff', '--tests-passed'], io);
    expect(code).toBe(1);
    expect(err()).toContain('--diff requires a value');
  });

  it('sends an unprotected binary diff to a human instead of allowing it', async () => {
    const file = writeTempDiff('binary-asset.diff', BINARY_ASSET_DIFF);
    const { io, out } = captureIO();
    const code = await runCli(['check', '--diff', file, '--tests-passed'], io);
    expect(code).toBe(3);
    expect(out()).toContain('outcome: human');
    expect(out()).toContain('uninspectable-binary');
  });

  it('blocks a binary diff touching a protected path (B3: no +++ headers)', async () => {
    const file = writeTempDiff('binary-payments.diff', BINARY_PAYMENTS_DIFF);
    const { io, out } = captureIO();
    const code = await runCli(['check', '--diff', file, '--tests-passed'], io);
    expect(code).toBe(2);
    expect(out()).toContain('block');
    expect(out()).toContain('protected-paths');
    expect(out()).toContain('src/payments/logo.png');
  });

  it('blocks a rename that moves a file OUT of a protected path (B3: old path kept)', async () => {
    const file = writeTempDiff('rename-away.diff', RENAME_AWAY_FROM_PAYMENTS_DIFF);
    const { io, out } = captureIO();
    const code = await runCli(['check', '--diff', file, '--tests-passed'], io);
    expect(code).toBe(2);
    expect(out()).toContain('block');
    expect(out()).toContain('protected-paths');
    expect(out()).toContain('src/payments/charge.ts');
  });
});

describe('jevladder route', () => {
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

  it('usage-errors on empty or whitespace task text', async () => {
    for (const text of ['', '   ']) {
      const { io, err } = captureIO();
      const code = await runCli(['route', '--explain', text], io);
      expect(code).toBe(1);
      expect(err()).toContain('empty');
    }
  });

  it('usage-errors without --explain', async () => {
    const { io, err } = captureIO();
    const code = await runCli(['route'], io);
    expect(code).toBe(1);
    expect(err()).toContain('--explain');
  });

  it('usage-errors when --explain swallows another flag instead of text (S7)', async () => {
    const { io, err } = captureIO();
    const code = await runCli(['route', '--explain', '--json'], io);
    expect(code).toBe(1);
    expect(err()).toContain('--explain requires task text');
  });

  it('accepts --json in any position (S7)', async () => {
    const { io, out } = captureIO();
    const code = await runCli(['route', '--json', '--explain', 'Rename a typo in the docs'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out()) as { tier: string };
    expect(parsed.tier).toBe('cheap');
  });
});

describe('jevladder top-level', () => {
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
