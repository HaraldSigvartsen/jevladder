import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_JUDGE_API_KEY_ENV,
  JEVLADDER_TYPESAFE_API_KEY_ENV,
  TYPESAFE_API_KEY_ENV,
} from '../src/index.js';
import { runCli } from '../src/cli.js';
import type { CliIO } from '../src/cli.js';
import {
  DECISION_LOG_MINIMUM,
  buildConfigProposal,
  formatConfigProposal,
} from '../src/proposal.js';
import { configProposalPullRequest, openConfigProposalPullRequest } from '../src/proposal-pr.js';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const IN_WINDOW = '2026-10-20T12:00:00.000Z';
const OLD = '2026-10-01T12:00:00.000Z';

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function record(outcome: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: IN_WINDOW, outcome, source: 'rule', ...extra });
}

function blocks(ruleId: string, count: number): string[] {
  return Array.from({ length: count }, () => record('block', { ruleId }));
}

describe('buildConfigProposal', () => {
  it('waits for enough in-window decisions and drops unsafe fields', () => {
    const secret = 'SECRET_DIFF_PATH_REASON';
    const lines = [
      record('block', { ruleId: 'protected-paths', diff: secret, path: secret, reason: secret }),
      JSON.stringify({ ts: OLD, outcome: 'block', source: 'rule', ruleId: 'protected-paths' }),
      `${secret}${'x'.repeat(1100)}`,
      '{',
      record('block', { ruleId: 'not a rule' }),
    ];
    const proposal = buildConfigProposal(lines.join('\n'), NOW);
    expect(proposal.status).toBe('insufficient');
    expect(proposal.entries).toBe(1);
    expect(proposal.outsideWindow).toBe(1);
    expect(proposal.malformedLines).toBe(3);
    expect(proposal.suggestions).toEqual([]);
    expect(proposal.appliesConfig).toBe(false);
    expect(proposal.autoMerge).toBe(false);
    expect(JSON.stringify(proposal)).not.toContain(secret);
    expect(formatConfigProposal(proposal)).toContain('does not merge');
    expect(formatConfigProposal(proposal)).not.toContain(secret);
  });

  it('suggests a human review when one rule dominates recent blocks', () => {
    const lines = [
      ...blocks('protected-paths', 10),
      ...Array.from({ length: 10 }, () => JSON.stringify({ ts: IN_WINDOW, outcome: 'allow', source: 'judge' })),
    ];
    expect(lines).toHaveLength(DECISION_LOG_MINIMUM);
    const proposal = buildConfigProposal(lines.join('\n'), NOW);
    expect(proposal.status).toBe('review');
    expect(proposal.suggestions).toHaveLength(1);
    expect(proposal.suggestions[0]?.ruleId).toBe('protected-paths');
    expect(proposal.suggestions[0]?.text).toContain('does not change config and does not merge');
    const quiet = buildConfigProposal(
      Array.from({ length: DECISION_LOG_MINIMUM }, () => JSON.stringify({ ts: IN_WINDOW, outcome: 'allow', source: 'judge' })).join('\n'),
      NOW,
    );
    expect(quiet.status).toBe('review');
    expect(quiet.suggestions).toEqual([]);
    expect(formatConfigProposal(quiet)).toContain('No config change proposed.');
  });
});

describe('jevladder propose', () => {
  beforeEach(() => {
    vi.stubEnv(DEFAULT_JUDGE_API_KEY_ENV, '');
    vi.stubEnv(JEVLADDER_TYPESAFE_API_KEY_ENV, '');
    vi.stubEnv(TYPESAFE_API_KEY_ENV, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('check writes a privacy-safe line and propose will not apply it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevladder-propose-'));
    tempDirs.push(dir);
    const log = join(dir, 'decisions.jsonl');
    const diff = join(dir, 'secret.diff');
    const secret = 'PRIVATE_CHECK_DIFF';
    writeFileSync(diff, `diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+password = "${secret}"\n`, 'utf8');
    process.env.JEVLADDER_DECISION_LOG = log;
    const io: CliIO = { stdout: () => {}, stderr: () => {} };
    try {
      expect(await runCli(['check', '--diff', diff, '--tests-passed'], io)).toBe(2);
      const written = readFileSync(log, 'utf8');
      expect(written).toContain('"ruleId":"secrets-in-diff"');
      expect(written).not.toContain(secret);
      const { out, io: proposeIo } = capture();
      expect(await runCli(['propose', '--log', log, '--json'], proposeIo)).toBe(0);
      expect(out()).toContain('"status": "insufficient"');
      expect(out()).toContain('"autoMerge": false');
      expect(out()).not.toContain(secret);
    } finally {
      delete process.env.JEVLADDER_DECISION_LOG;
    }
  });

  it('skips the decision log when logging is disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevladder-propose-off-'));
    tempDirs.push(dir);
    const log = join(dir, 'decisions.jsonl');
    const diff = join(dir, 'safe.diff');
    writeFileSync(diff, 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n', 'utf8');
    process.env.JEVLADDER_DECISION_LOG = log;
    process.env.JEVLADDER_NO_LOG = '1';
    try {
      const io: CliIO = { stdout: () => {}, stderr: () => {} };
      expect(await runCli(['check', '--diff', diff, '--tests-passed'], io)).toBe(3);
      expect(() => readFileSync(log, 'utf8')).toThrow();
      const { out, io: proposeIo } = capture();
      expect(await runCli(['propose', '--log', log], proposeIo)).toBe(0);
      expect(out()).toContain('Config proposal unavailable');
    } finally {
      delete process.env.JEVLADDER_DECISION_LOG;
      delete process.env.JEVLADDER_NO_LOG;
    }
  });
});

describe('config proposal pull request', () => {
  function reviewLog(): string {
    const blocks = Array.from({ length: 10 }, () => JSON.stringify({
      ts: IN_WINDOW, outcome: 'block', source: 'rule', ruleId: 'protected-paths', diff: 'SECRET_DIFF',
    }));
    const allows = Array.from({ length: 10 }, () => JSON.stringify({ ts: IN_WINDOW, outcome: 'allow', source: 'judge' }));
    return [...blocks, ...allows].join('\n');
  }

  it('opens one pull request and never merges', () => {
    const proposal = buildConfigProposal(reviewLog(), NOW);
    const request = configProposalPullRequest(proposal, NOW, 'main');
    expect(request).not.toBeNull();
    expect(request?.branch).toBe('jevladder/config-proposal-2026-10-21');
    expect(request?.path).toBe('docs/config-proposals/2026-10-21.md');
    expect(request?.content).toContain('Do not auto-merge.');
    expect(request?.content).not.toContain('SECRET_DIFF');
    expect(request?.body).toContain('must not be auto-merged');

    const calls: string[][] = [];
    const opened = openConfigProposalPullRequest(request!, {
      cwd: '/repo',
      run(command, args, cwd) {
        calls.push([command, ...args]);
        if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') mkdirSync(args[3] as string, { recursive: true });
        if (command === 'gh') {
          expect(cwd).not.toBe('/repo');
          return 'https://github.com/example/jevladder/pull/9\n';
        }
        return '';
      },
    });
    expect(opened.url).toBe('https://github.com/example/jevladder/pull/9');
    const flat = calls.map((call) => call.join(' '));
    expect(flat.some((call) => call.startsWith('gh pr create'))).toBe(true);
    expect(calls.some((call) => call.includes('--merge') || (call[0] === 'gh' && call[2] === 'merge'))).toBe(false);
    expect(flat.some((call) => call.includes('refs/heads/jevladder/config-proposal-2026-10-21'))).toBe(true);
    expect(flat.some((call) => call.includes('refs/heads/main'))).toBe(false);
  });

  it('propose --open asks a human and rejects --merge', async () => {
    // The fixture log carries fixed timestamps (IN_WINDOW) while the CLI reads
    // wall-clock new Date(); pin Date so the 7-day window can never rot this test.
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const dir = mkdtempSync(join(tmpdir(), 'jevladder-propose-open-'));
    tempDirs.push(dir);
    const log = join(dir, 'decisions.jsonl');
    writeFileSync(log, reviewLog(), 'utf8');
    const expected = configProposalPullRequest(buildConfigProposal(reviewLog(), NOW), NOW);
    const opened: string[] = [];
    const { out, io } = capture();
    const code = await runCli(['propose', '--log', log, '--open'], io, {
      openProposal(request) {
        opened.push(request.branch);
        expect(request.content).not.toContain('SECRET_DIFF');
        return { url: 'https://github.com/example/jevladder/pull/9' };
      },
    });
    expect(code).toBe(0);
    expect(opened).toEqual([expected?.branch]);
    expect(out()).toContain('pull request: https://github.com/example/jevladder/pull/9');
    expect(out()).toContain('Not merged.');

    const quiet = capture();
    expect(await runCli(['propose', '--log', log], quiet.io, {
      openProposal() {
        throw new Error('should not open');
      },
    })).toBe(0);
    expect(quiet.out()).toContain('No pull request opened.');

    const refused = capture();
    expect(await runCli(['propose', '--merge'], refused.io)).toBe(1);
  });
});

function capture(): { io: CliIO; out: () => string } {
  let out = '';
  return {
    io: { stdout: (text) => { out += text; }, stderr: () => {} },
    out: () => out,
  };
}
