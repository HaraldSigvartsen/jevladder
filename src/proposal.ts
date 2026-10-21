import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DECISION_LOG_WINDOW_DAYS = 7;
export const DECISION_LOG_MINIMUM = 20;
export const DECISION_RULE_MINIMUM = 10;
export const DECISION_RULE_SHARE = 0.5;
const MAX_LINE_CHARS = 1024;

const OUTCOMES = ['allow', 'block', 'human'] as const;
const SOURCES = ['rule', 'judge', 'human', 'none'] as const;

export type ProposalOutcome = (typeof OUTCOMES)[number];
export type ProposalSource = (typeof SOURCES)[number];

export interface DecisionRecord {
  ts: string;
  outcome: ProposalOutcome;
  source: ProposalSource;
  ruleId?: string;
}

export interface ConfigSuggestion {
  ruleId: string;
  blocks: number;
  blockTotal: number;
  text: string;
}

export interface ConfigProposal {
  status: 'insufficient' | 'review';
  windowDays: number;
  minimumEntries: number;
  entries: number;
  malformedLines: number;
  outsideWindow: number;
  outcomes: Record<ProposalOutcome, number>;
  suggestions: ConfigSuggestion[];
  /** The command never writes config. */
  appliesConfig: false;
  /** The command never opens or merges a pull request. */
  autoMerge: false;
}

function emptyOutcomes(): Record<ProposalOutcome, number> {
  return { allow: 0, block: 0, human: 0 };
}

export function defaultDecisionLogPath(): string {
  const fromEnv = process.env.JEVLADDER_DECISION_LOG;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return join(homedir(), '.jevladder', 'decisions.jsonl');
}

function safeRuleId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-z0-9-]+$/.test(value)) return undefined;
  return value;
}

/** Keep only the privacy-safe fields. Extra fields are dropped, never copied. */
export function parseDecisionRecord(value: unknown): DecisionRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.ts !== 'string' || Number.isNaN(Date.parse(record.ts))) return null;
  if (typeof record.outcome !== 'string' || !OUTCOMES.includes(record.outcome as ProposalOutcome)) return null;
  if (typeof record.source !== 'string' || !SOURCES.includes(record.source as ProposalSource)) return null;
  if (record.ruleId !== undefined && safeRuleId(record.ruleId) === undefined) return null;
  const parsed: DecisionRecord = {
    ts: record.ts,
    outcome: record.outcome as ProposalOutcome,
    source: record.source as ProposalSource,
  };
  const ruleId = safeRuleId(record.ruleId);
  if (ruleId !== undefined) parsed.ruleId = ruleId;
  return parsed;
}

/**
 * Append one gate decision. The line is `{ts, outcome, source, ruleId?}`.
 * Diff text, paths, and reasons are not written. Errors are ignored.
 */
export function appendDecisionRecord(
  decision: { outcome: string; source: string; ruleId?: string },
  path = defaultDecisionLogPath(),
): void {
  try {
    const optOut = process.env.JEVLADDER_NO_LOG;
    if (optOut === '1' || optOut === 'true') return;
    const record = parseDecisionRecord({
      ts: new Date().toISOString(),
      outcome: decision.outcome,
      source: decision.source,
      ...(decision.ruleId !== undefined ? { ruleId: decision.ruleId } : {}),
    });
    if (record === null) return;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size >= 1024 * 1024) renameSync(path, `${path}.1`);
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // A proposal log must not change the gate exit code.
  }
}

export function buildConfigProposal(logText: string, now = new Date()): ConfigProposal {
  const outcomes = emptyOutcomes();
  const ruleBlocks = new Map<string, number>();
  let malformedLines = 0;
  let outsideWindow = 0;
  let entries = 0;
  const windowStart = now.getTime() - DECISION_LOG_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  for (const line of logText.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (line.length > MAX_LINE_CHARS) {
      malformedLines++;
      continue;
    }
    try {
      const record = parseDecisionRecord(JSON.parse(line) as unknown);
      if (record === null) {
        malformedLines++;
        continue;
      }
      const ts = Date.parse(record.ts);
      if (ts < windowStart || ts > now.getTime()) {
        outsideWindow++;
        continue;
      }
      entries++;
      outcomes[record.outcome]++;
      if (record.outcome === 'block' && record.source === 'rule' && record.ruleId !== undefined) {
        ruleBlocks.set(record.ruleId, (ruleBlocks.get(record.ruleId) ?? 0) + 1);
      }
    } catch {
      malformedLines++;
    }
  }

  const suggestions: ConfigSuggestion[] = [];
  if (entries >= DECISION_LOG_MINIMUM && outcomes.block > 0) {
    for (const [ruleId, blocks] of ruleBlocks) {
      if (blocks < DECISION_RULE_MINIMUM) continue;
      if (blocks / outcomes.block < DECISION_RULE_SHARE) continue;
      suggestions.push({
        ruleId,
        blocks,
        blockTotal: outcomes.block,
        text:
          `${ruleId} blocked ${blocks} of ${outcomes.block} blocks in the last ${DECISION_LOG_WINDOW_DAYS} days. ` +
          'A human may review that rule in a pull request. This command does not change config and does not merge.',
      });
    }
    suggestions.sort((a, b) => b.blocks - a.blocks || a.ruleId.localeCompare(b.ruleId));
  }

  return {
    status: entries >= DECISION_LOG_MINIMUM ? 'review' : 'insufficient',
    windowDays: DECISION_LOG_WINDOW_DAYS,
    minimumEntries: DECISION_LOG_MINIMUM,
    entries,
    malformedLines,
    outsideWindow,
    outcomes,
    suggestions,
    appliesConfig: false,
    autoMerge: false,
  };
}

export function formatConfigProposal(proposal: ConfigProposal, json = false): string {
  if (json) return `${JSON.stringify(proposal, null, 2)}\n`;
  const lines = [
    `status: ${proposal.status}`,
    `window: ${proposal.windowDays} days`,
    `entries: ${proposal.entries}`,
    `minimum: ${proposal.minimumEntries}`,
    `malformed lines skipped: ${proposal.malformedLines}`,
    `outside window: ${proposal.outsideWindow}`,
    `outcomes: allow ${proposal.outcomes.allow}, block ${proposal.outcomes.block}, human ${proposal.outcomes.human}`,
  ];
  if (proposal.status === 'insufficient') {
    lines.push('Not enough decisions to propose a config change.');
  } else if (proposal.suggestions.length === 0) {
    lines.push('No config change proposed.');
  } else {
    lines.push('suggestions:');
    for (const suggestion of proposal.suggestions) lines.push(`  - ${suggestion.text}`);
  }
  lines.push('This command does not change config and does not open or merge a pull request.');
  return `${lines.join('\n')}\n`;
}

export function readConfigProposal(logPath = defaultDecisionLogPath(), now = new Date()):
  | { ok: true; proposal: ConfigProposal }
  | { ok: false; message: string } {
  try {
    return { ok: true, proposal: buildConfigProposal(readFileSync(logPath, 'utf8'), now) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Config proposal unavailable: cannot read decision log "${logPath}" (${detail}).` };
  }
}
