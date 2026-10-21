#!/usr/bin/env node
/**
 * `jevladder` CLI: merge-gate checks, deterministic task routing, and plugin emit.
 *
 * Commands:
 *   jevladder check [--diff <file>] [--tests-passed|--tests-failed] [--irreversible] [--json]
 *   jevladder route --explain "<task text>" [--json]
 *   jevladder plugin --out <dir> [--protected <glob> ...]
 *   jevladder report [--log <path>] [--json]
 *   jevladder propose [--log <path>] [--json]
 *   jevladder --help | --version
 *
 * Exit codes: 0 allow, 1 usage/IO error, 2 block, 3 human decision required.
 * Unspecified test status counts as not green (never fail open).
 *
 * TRUST BOUNDARY: `jevladder check` expects an authoritative unified diff (e.g.
 * `git diff` output piped or saved to a file), never agent-authored prose.
 * File paths are parsed from the diff itself (`diff --git`, `+++` headers,
 * `Binary files … differ` notices, including both sides of renames).
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineGate } from './gate.js';
import { isStructuredDiff, parseDiffFilePaths } from './diff-parse.js';
import { makeMergeRules } from './rules/merge-rules.js';
import { MockJudge } from './judge/mock.js';
import { parseJevLadderPluginConfig, writePluginFiles } from './plugin.js';
import { scoreRoute } from './route.js';
import { formatCostReport, readCostReport } from './report.js';
import { appendDecisionRecord, formatConfigProposal, readConfigProposal } from './proposal.js';
import { configProposalPullRequest, openConfigProposalPullRequest } from './proposal-pr.js';
import type { ConfigProposalPullRequest } from './proposal-pr.js';

/** Output/input seams so tests can capture everything the CLI emits. */
export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin?(): string;
}

/** Test seam. Production opens the proposal pull request with git and gh. */
export interface CliDependencies {
  openProposal?: (request: ConfigProposalPullRequest) => { url: string };
}

const VERSION_FALLBACK = '0.6.0';

function readVersion(): string {
  try {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version;
    return typeof version === 'string' && version !== '' ? version : VERSION_FALLBACK;
  } catch {
    return VERSION_FALLBACK;
  }
}

const USAGE = `jevladder — ladder-gate for AI agents

Usage:
  jevladder check [--diff <file>] [--tests-passed|--tests-failed] [--irreversible] [--json]
  jevladder route --explain "<task text>" [--json]
  jevladder plugin --out <dir> [--config <json>] [--protected <glob> ...]
  jevladder report [--log <path>] [--json]
  jevladder propose [--log <path>] [--json]
  jevladder --help | --version

check — run the merge gate over a unified diff
  --diff <file>     Path to a unified diff (e.g. git diff output), or "-" to read stdin (default stdin).
  --tests-passed    Test suite is green.
  --tests-failed    Test suite is red (also the default when unspecified).
  --irreversible    The merge cannot be undone once applied.
  --json            Print the decision as JSON.

route — score a task description deterministically (no model calls)
  --explain <text>  Task text to score (required).
  --json            Print the routing result as JSON.

plugin — write the Codex-first advisory plugin files (legacy Claude Code supported) (never blocks)
  --config <json>   Plugin JSON config (subagentModels, protectedPaths, logFileName).
  --out <dir>       Output directory (required).
  --protected <g>   Protected-path glob embedded in config.json (repeatable).

report — summarize privacy-safe observe log entries and simulated tier costs
  --log <path>      Observe log path (default ~/.jevladder/observe.jsonl).
  --json            Print the report as JSON.

propose — print a config suggestion from the privacy-safe decision log
  --log <path>      Decision log path (default ~/.jevladder/decisions.jsonl, or JEVLADDER_DECISION_LOG).
  --json            Print the proposal as JSON.
  --open            Open a pull request for a human to approve. Refuses when there is no suggestion.
  --base <branch>   Base branch for --open (default main).
  Does not edit gate config. Never merges the pull request. --merge is rejected.

The diff must be authoritative git diff output (not agent-authored text);
empty or non-diff input is a usage error (exit 1), never an implicit allow.

Exit codes: 0 allow, 1 usage/IO error, 2 block, 3 human decision required.`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultIO(): CliIO {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    readStdin: () => {
      if (process.stdin.isTTY) {
        throw new Error('stdin is a terminal; pass --diff <file> or pipe a diff in');
      }
      return readFileSync(0, 'utf8');
    },
  };
}

function usageError(io: CliIO, message: string): number {
  io.stderr(`jevladder: ${message}\n`);
  io.stderr(`Run "jevladder --help" for usage.\n`);
  return 1;
}

async function runCheck(args: string[], io: CliIO): Promise<number> {
  let diffArg: string | null = null;
  let sawPassed = false;
  let sawFailed = false;
  let irreversible = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--diff') {
      const value: string | undefined = args[++i];
      if (value === undefined) return usageError(io, 'check: --diff requires a value');
      if (value.startsWith('--')) {
        return usageError(io, `check: --diff requires a value, got "${value}"`);
      }
      diffArg = value;
    } else if (arg === '--tests-passed') {
      sawPassed = true;
    } else if (arg === '--tests-failed') {
      sawFailed = true;
    } else if (arg === '--irreversible') {
      irreversible = true;
    } else if (arg === '--json') {
      json = true;
    } else {
      return usageError(io, `check: unknown option "${arg}"`);
    }
  }
  if (sawPassed && sawFailed) {
    return usageError(io, 'check: --tests-passed and --tests-failed are mutually exclusive');
  }

  let diff: string;
  if (diffArg !== null && diffArg !== '-') {
    try {
      diff = readFileSync(diffArg, 'utf8');
    } catch (error) {
      io.stderr(`jevladder: cannot read diff "${diffArg}": ${errorMessage(error)}\n`);
      return 1;
    }
  } else {
    if (!io.readStdin) return usageError(io, 'check: no --diff given and stdin is not available');
    try {
      diff = io.readStdin();
    } catch (error) {
      io.stderr(`jevladder: cannot read diff from stdin: ${errorMessage(error)}\n`);
      return 1;
    }
  }

  // Never fail open: empty or structure-less input is a usage error, not an
  // implicit allow. A real unified diff always contains at least one
  // `diff --git` line, `+++` header, or `@@` hunk marker.
  if (diff.trim() === '') {
    return usageError(io, 'check: diff is empty; refusing to run the gate on no input');
  }
  if (!isStructuredDiff(diff)) {
    return usageError(
      io,
      'check: input does not look like a unified diff (no "diff --git", "+++", or "@@" line found); feed authoritative git diff output',
    );
  }

  const gate = defineGate({ rules: makeMergeRules(), judge: new MockJudge() });
  const decision = await gate.decide({
    action: 'merge',
    diff,
    files: parseDiffFilePaths(diff),
    irreversible,
    context: { testsPassed: sawPassed },
  });
  appendDecisionRecord(decision);

  if (json) {
    io.stdout(
      `${JSON.stringify(
        {
          outcome: decision.outcome,
          source: decision.source,
          ruleId: decision.ruleId,
          judgeVerdict: decision.judgeVerdict,
          reason: decision.reason,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.stdout(`outcome: ${decision.outcome}\n`);
    io.stdout(`source:  ${decision.source}${decision.ruleId ? ` (${decision.ruleId})` : ''}\n`);
    io.stdout(`reason:  ${decision.reason}\n`);
    if (decision.judgeVerdict) {
      const { verdict, score, evidence } = decision.judgeVerdict;
      io.stdout(`judge:   ${verdict} ${score} — ${evidence}\n`);
    }
  }

  if (decision.outcome === 'allow') return 0;
  if (decision.outcome === 'block') return 2;
  return 3;
}

function runRoute(args: string[], io: CliIO): number {
  let explain: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--explain') {
      const value: string | undefined = args[++i];
      if (value === undefined) return usageError(io, 'route: --explain requires a value');
      if (value.startsWith('--')) {
        return usageError(io, `route: --explain requires task text, got "${value}"`);
      }
      explain = value;
    } else if (arg === '--json') {
      json = true;
    } else {
      return usageError(io, `route: unknown option "${arg}"`);
    }
  }
  if (explain === undefined) return usageError(io, 'route: --explain <text> is required');
  if (explain.trim() === '') return usageError(io, 'route: task text is empty');

  const result = scoreRoute(explain);
  if (result.rejected) return usageError(io, `route: ${result.reason}`);
  if (json) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  io.stdout(`tier:          ${result.tier}\n`);
  io.stdout(`abstained:     ${result.abstained}\n`);
  io.stdout(`difficulty:    ${result.axes.difficulty.toFixed(3)}\n`);
  io.stdout(`consequence:   ${result.axes.consequence.toFixed(3)}\n`);
  io.stdout(`verifiability: ${result.axes.verifiability.toFixed(3)}\n`);
  if (result.signals.length === 0) {
    io.stdout('signals:       none\n');
  } else {
    io.stdout('signals:\n');
    for (const signal of result.signals) {
      io.stdout(`  - ${signal.signal} (+${signal.weight}) ${signal.detail}\n`);
    }
  }
  io.stdout(`explanation:   ${result.explanation}\n`);
  return 0;
}

function runPlugin(args: string[], io: CliIO): number {
  let outDir: string | undefined;
  let configPath: string | undefined;
  const protectedPaths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--out') {
      const value: string | undefined = args[++i];
      if (value === undefined) return usageError(io, 'plugin: --out requires a directory');
      if (value.startsWith('--')) {
        return usageError(io, `plugin: --out requires a directory, got "${value}"`);
      }
      outDir = value;
    } else if (arg === '--config') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) {
        return usageError(io, 'plugin: --config requires a JSON file');
      }
      configPath = value;
    } else if (arg === '--protected') {
      const value: string | undefined = args[++i];
      if (value === undefined) return usageError(io, 'plugin: --protected requires a glob');
      if (value.startsWith('--')) {
        return usageError(io, `plugin: --protected requires a glob, got "${value}"`);
      }
      protectedPaths.push(value);
    } else {
      return usageError(io, `plugin: unknown option "${arg}"`);
    }
  }

  if (outDir === undefined) return usageError(io, 'plugin: --out <dir> is required');

  try {
    const config = configPath === undefined
      ? {}
      : parseJevLadderPluginConfig(JSON.parse(readFileSync(configPath, 'utf8')));
    const abs = resolve(outDir);
    const written = writePluginFiles(abs, {
      ...config,
      ...(protectedPaths.length > 0 ? { protectedPaths } : {}),
    });
    for (const path of written) {
      io.stdout(`${path}\n`);
    }
    return 0;
  } catch (error) {
    io.stderr(`jevladder: cannot write plugin to "${outDir}": ${errorMessage(error)}\n`);
    return 1;
  }
}

function runReport(args: string[], io: CliIO): number {
  let logPath: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--log') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) {
        return usageError(io, 'report: --log requires a path');
      }
      logPath = value;
    } else if (arg === '--json') {
      json = true;
    } else {
      return usageError(io, `report: unknown option "${arg}"`);
    }
  }

  const result = readCostReport(logPath);
  if (!result.ok) {
    io.stdout(`${result.message}\n`);
    return 0;
  }
  io.stdout(formatCostReport(result.report, json));
  return 0;
}

function runPropose(args: string[], io: CliIO, dependencies: CliDependencies): number {
  let logPath: string | undefined;
  let json = false;
  let open = false;
  let base = 'main';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--log') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) {
        return usageError(io, 'propose: --log requires a path');
      }
      logPath = value;
    } else if (arg === '--base') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) {
        return usageError(io, 'propose: --base requires a branch');
      }
      base = value;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--open') {
      open = true;
    } else if (arg === '--merge') {
      return usageError(io, 'propose: refusing to merge; a human approves the pull request');
    } else {
      return usageError(io, `propose: unknown option "${arg}"`);
    }
  }

  const result = readConfigProposal(logPath);
  if (!result.ok) {
    io.stdout(`${result.message}\n`);
    return 0;
  }
  io.stdout(formatConfigProposal(result.proposal, json));
  if (!open) {
    io.stdout('No pull request opened.\n');
    return 0;
  }
  const request = configProposalPullRequest(result.proposal, new Date(), base);
  if (request === null) {
    io.stdout('No pull request opened.\n');
    return 0;
  }
  try {
    const opened = dependencies.openProposal
      ? dependencies.openProposal(request)
      : openConfigProposalPullRequest(request, { cwd: process.cwd() });
    io.stdout(`pull request: ${opened.url}\n`);
    io.stdout('Left open for a human. Not merged.\n');
    return 0;
  } catch (error) {
    io.stderr(`jevladder: cannot open config proposal pull request: ${errorMessage(error)}\n`);
    return 1;
  }
}

/** Run the CLI against explicit arguments and IO; returns the process exit code. */
export async function runCli(args: string[], io?: CliIO, dependencies: CliDependencies = {}): Promise<number> {
  const channels = io ?? defaultIO();
  const command: string | undefined = args[0];

  if (command === undefined) {
    channels.stderr(`${USAGE}\n`);
    return 1;
  }
  if (command === '--help' || command === '-h') {
    channels.stdout(`${USAGE}\n`);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    channels.stdout(`${readVersion()}\n`);
    return 0;
  }
  if (command === 'check') return runCheck(args.slice(1), channels);
  if (command === 'route') return runRoute(args.slice(1), channels);
  if (command === 'plugin') return runPlugin(args.slice(1), channels);
  if (command === 'report') return runReport(args.slice(1), channels);
  if (command === 'propose') return runPropose(args.slice(1), channels, dependencies);

  channels.stderr(`jevladder: unknown command "${command}"\n\n${USAGE}\n`);
  return 1;
}

const invokedAsScript = (() => {
  try {
    const entry = process.argv[1];
    return (
      typeof entry === 'string' && import.meta.url === pathToFileURL(realpathSync(entry)).href
    );
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
