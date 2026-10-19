import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ReportTier = 'cheap' | 'mid' | 'frontier';

/** Mock/simulated prices per routed task; mirrored from eval/run.ts PRICES. */
export const REPORT_PRICES: Record<ReportTier, number> = {
  cheap: 0.002,
  mid: 0.01,
  frontier: 0.05,
};

export interface CostReport {
  entries: number;
  malformedLines: number;
  tierDistribution: Record<ReportTier, { count: number; percent: number }>;
  costPerRoutedTask: Record<ReportTier, number>;
  simulatedCostByTier: Record<ReportTier, number>;
  totalSimulatedCost: number;
}

const TIERS: ReportTier[] = ['cheap', 'mid', 'frontier'];

export function buildCostReport(logText: string): CostReport {
  const counts: Record<ReportTier, number> = { cheap: 0, mid: 0, frontier: 0 };
  let malformedLines = 0;

  for (const line of logText.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (typeof entry !== 'object' || entry === null) {
        malformedLines++;
      } else {
        const value = entry as Record<string, unknown>;
        const tier = value.tier;
        const valid = typeof value.ts === 'string' &&
          typeof value.session_id === 'string' &&
          typeof value.cwd === 'string' &&
          Array.isArray(value.signals) && value.signals.every((signal) => typeof signal === 'string') &&
          typeof value.promptChars === 'number' && Number.isFinite(value.promptChars) &&
          typeof tier === 'string' && TIERS.includes(tier as ReportTier);
        if (!valid) {
          malformedLines++;
        } else {
          counts[tier as ReportTier]++;
        }
      }
    } catch {
      malformedLines++;
    }
  }

  const entries = counts.cheap + counts.mid + counts.frontier;
  const tierDistribution = Object.fromEntries(
    TIERS.map((tier) => [tier, { count: counts[tier], percent: entries === 0 ? 0 : (counts[tier] / entries) * 100 }]),
  ) as CostReport['tierDistribution'];
  const simulatedCostByTier = Object.fromEntries(
    TIERS.map((tier) => [tier, counts[tier] * REPORT_PRICES[tier]]),
  ) as CostReport['simulatedCostByTier'];

  return {
    entries,
    malformedLines,
    tierDistribution,
    costPerRoutedTask: { ...REPORT_PRICES },
    simulatedCostByTier,
    totalSimulatedCost: TIERS.reduce((total, tier) => total + simulatedCostByTier[tier], 0),
  };
}

export function readCostReport(logPath = join(homedir(), '.tierclef', 'observe.jsonl')):
  | { ok: true; report: CostReport }
  | { ok: false; message: string } {
  try {
    return { ok: true, report: buildCostReport(readFileSync(logPath, 'utf8')) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Cost report unavailable: cannot read observe log "${logPath}" (${detail}).` };
  }
}

export function formatCostReport(report: CostReport, json = false): string {
  if (json) {
    return `${JSON.stringify({
      entries: report.entries,
      malformedLines: report.malformedLines,
      tierDistribution: Object.fromEntries(
        TIERS.map((tier) => [tier, { ...report.tierDistribution[tier], label: 'measured (from log)' }]),
      ),
      costPerRoutedTask: Object.fromEntries(
        TIERS.map((tier) => [tier, { amount: report.costPerRoutedTask[tier], label: 'simulated' }]),
      ),
      simulatedCostByTier: Object.fromEntries(
        TIERS.map((tier) => [tier, { amount: report.simulatedCostByTier[tier], label: 'simulated' }]),
      ),
      totalSimulatedCost: { amount: report.totalSimulatedCost, label: 'simulated' },
    }, null, 2)}\n`;
  }

  const lines = [
    `entries: ${report.entries}`,
    `malformed lines skipped: ${report.malformedLines}`,
    'tier distribution (measured from log):',
  ];
  for (const tier of TIERS) {
    const distribution = report.tierDistribution[tier];
    lines.push(`  ${tier}: ${distribution.count} (${distribution.percent.toFixed(1)}%)`);
  }
  lines.push('cost per routed task (simulated):');
  for (const tier of TIERS) lines.push(`  ${tier}: $${report.costPerRoutedTask[tier].toFixed(3)}`);
  lines.push('simulated cost by tier:');
  for (const tier of TIERS) lines.push(`  ${tier}: $${report.simulatedCostByTier[tier].toFixed(3)}`);
  lines.push(`total simulated cost: $${report.totalSimulatedCost.toFixed(3)}`);
  lines.push('Prices are mock estimates, not actual provider spend.');
  return `${lines.join('\n')}\n`;
}
