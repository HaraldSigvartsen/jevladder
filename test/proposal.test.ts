import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import type { CliIO } from '../src/cli.js';
import {
  DECISION_LOG_MINIMUM,
  buildConfigProposal,
  formatConfigProposal,
} from '../src/proposal.js';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const IN_WINDOW = '2026-10-20T12:00:00.000Z';
const OLD = '2026-10-01T12:00:00.000Z';

const tempDirs: string[] = [];

afterEach(() => {
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
    expect(formatConfigProposal(proposal)).toContain('does not open or merge');
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
      expect(await runCli(['check', '--diff', diff, '--tests-passed'], io)).toBe(0);
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

function capture(): { io: CliIO; out: () => string } {
  let out = '';
  return {
    io: { stdout: (text) => { out += text; }, stderr: () => {} },
    out: () => out,
  };
}
