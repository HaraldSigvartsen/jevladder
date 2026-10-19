import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { buildCostReport, readCostReport } from '../src/report.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function tempLog(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tierclef-report-'));
  tempDirs.push(dir);
  const path = join(dir, 'observe.jsonl');
  writeFileSync(path, content, 'utf8');
  return path;
}

function entry(tier: string): string {
  return JSON.stringify({ ts: '2026-10-19T00:00:00.000Z', session_id: 'test', cwd: '/tmp', tier, signals: [], promptChars: 4 });
}

describe('cost report', () => {
  it('computes measured tier distribution and simulated costs', () => {
    const result = readCostReport(tempLog([entry('cheap'), entry('mid'), entry('mid'), entry('frontier')].join('\n')));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const report = result.report;
    expect(report.entries).toBe(4);
    expect(report.tierDistribution.mid).toEqual({ count: 2, percent: 50 });
    expect(report.costPerRoutedTask).toEqual({ cheap: 0.002, mid: 0.01, frontier: 0.05 });
    expect(report.simulatedCostByTier).toEqual({ cheap: 0.002, mid: 0.02, frontier: 0.05 });
    expect(report.totalSimulatedCost).toBeCloseTo(0.072);
  });

  it('skips and counts malformed lines', () => {
    const report = buildCostReport(`${entry('cheap')}\nnot json\n${entry('unknown')}\n{}`);
    expect(report.entries).toBe(1);
    expect(report.malformedLines).toBe(3);
  });

  it('returns a friendly advisory message and exit 0 for a missing file', async () => {
    let output = '';
    const code = await runCli(['report', '--log', '/missing/tierclef-observe-test.jsonl'], {
      stdout: (text) => { output += text; },
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(output).toContain('Cost report unavailable');
    expect(output).toContain('cannot read observe log');
  });
});
