/**
 * Codex-first plugin generator. Claude Code is the second host. OpenCode is the
 * third host adapter (v0.5 automatic layer). Cursor is the fourth host adapter
 * (project MCP config and rules only). ZCode is the fifth host adapter (global
 * config fragments under --out only; the user merges into ~/.zcode).
 *
 * Emits a loadable plugin directory: manifest, SessionStart, UserPromptSubmit,
 * and advisory PreToolUse hooks, a standalone observe script, config, and
 * README. The hook annotates prompts and write/merge tool use — it never
 * blocks, never sets a permission decision, and never changes models.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RouteTier } from './route.js';
import { typesafeMcpJudgeSnippet } from './judge/typesafe-mcp-snippet.js';

export type ClaudeCodeModelAlias = 'haiku' | 'sonnet' | 'opus' | 'inherit';

export interface JevLadderPluginConfig {
  /** Glob patterns copied into generated config.json (informational for now). */
  protectedPaths?: string[];
  /**
   * Preferred observe log basename under `~/.jevladder/`.
   * Sanitized to a single path segment (slashes stripped); weird input falls
   * back to {@link DEFAULT_LOG_FILE}. Env `JEVLADDER_OBSERVE_LOG` always wins over
   * this default at hook runtime.
   */
  logFileName?: string;
  /** Claude Code aliases for delegated subagents; omitted tiers use safe defaults. */
  subagentModels?: Partial<Record<RouteTier, ClaudeCodeModelAlias>>;
}

const DEFAULT_SUBAGENT_MODELS: Record<RouteTier, ClaudeCodeModelAlias> = {
  cheap: 'haiku',
  mid: 'sonnet',
  frontier: 'inherit',
};

/** Validate external JSON before it can reach generated YAML or scripts. */
export function parseJevLadderPluginConfig(raw: unknown): JevLadderPluginConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('plugin config must be an object');
  }
  const config = raw as Record<string, unknown>;
  if (config.protectedPaths !== undefined &&
      (!Array.isArray(config.protectedPaths) || config.protectedPaths.some((p) => typeof p !== 'string'))) {
    throw new TypeError('protectedPaths must be an array of strings');
  }
  if (config.logFileName !== undefined && typeof config.logFileName !== 'string') {
    throw new TypeError('logFileName must be a string');
  }
  if (config.subagentModels !== undefined) {
    const models = config.subagentModels;
    if (models === null || typeof models !== 'object' || Array.isArray(models) ||
        Object.entries(models).some(([tier, model]) =>
          !Object.hasOwn(DEFAULT_SUBAGENT_MODELS, tier) ||
          !['haiku', 'sonnet', 'opus', 'inherit'].includes(model as string))) {
      throw new TypeError('subagentModels must map cheap/mid/frontier to haiku/sonnet/opus/inherit');
    }
  }
  return {
    protectedPaths: config.protectedPaths as string[] | undefined,
    logFileName: config.logFileName as string | undefined,
    subagentModels: config.subagentModels as JevLadderPluginConfig['subagentModels'],
  };
}

const PLUGIN_VERSION = '0.6.0';
export const DEFAULT_LOG_FILE = 'observe.jsonl';
/** Workspace-relative path to the MCP server bundled with Cursor project config. */
export const CURSOR_BUNDLED_MCP_REL = '.cursor/jevladder/jevladder-mcp.mjs';
/** Path to the MCP server bundled with ZCode output, relative to the `zcode/` directory. */
export const ZCODE_BUNDLED_MCP_REL = 'jevladder/jevladder-mcp.mjs';
const IRREVERSIBLE_ACTIONS = ['deploy', 'migration', 'delete'] as const;

/** Safe observe log basename: no directories, no empty/`.`/`..`, printable-ish. */
export function sanitizeLogFileName(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_LOG_FILE;
  const trimmed = raw.trim();
  if (trimmed === '') return DEFAULT_LOG_FILE;
  // Basename only — strip any directory components / slashes.
  const base = trimmed.replace(/\\/g, '/').split('/').pop() ?? '';
  if (base === '' || base === '.' || base === '..') return DEFAULT_LOG_FILE;
  // Reject null bytes and other control chars; require a simple filename.
  if (/[\0\r\n]/.test(base)) return DEFAULT_LOG_FILE;
  if (!/^[\w.-]+\.[\w.-]+$/.test(base) && !/^[\w.-]+$/.test(base)) {
    return DEFAULT_LOG_FILE;
  }
  // Must look like a log file name (has an extension) or a simple token;
  // empty extension like "foo." → fallback.
  if (base.endsWith('.')) return DEFAULT_LOG_FILE;
  return base;
}

/** Shared advisory classifier emitted into host scripts. A miss stays silent; a hit never blocks. */
function mergeLikeSource(): string {
  return `function mergeLike(command) {
  // Advisory classification only. A miss stays silent; a hit never blocks.
  if (command.length === 0 || command.length > 8192) return false;
  return /(?:^|&&|\\|\\||;|\\n)\\s*(?:git\\s+(?:merge|push|rebase)(?![\\w-])|gh\\s+pr\\s+merge(?![\\w-]))/i.test(command);
}
`;
}

/** Shared generated source; mirrors scoreRoute in miniature, not the full router. */
function miniatureScorer(): string {
  return `// Mirrors scoreRoute in miniature; shared by the observe hook and MCP tools.
const RISK = [
  ['payments', /\\bpayments?\\b/i],
  ['auth', /\\bauth\\w*\\b/i],
  ['migration', /\\bmigrat\\w*\\b/i],
  ['delete', /\\bdelete\\w*\\b/i],
  ['production', /\\b(?:production|prod)\\b/i],
];

const AMBIGUOUS = /\\b(?:somehow|maybe|fix|stuff|things?|whatever|unclear|idk|tbd)\\b/i;

function scorePrompt(prompt) {
  const signals = [];
  for (const [name, re] of RISK) {
    if (re.test(prompt)) signals.push(name);
  }
  const trimmed = prompt.trim();
  const words = trimmed === '' ? [] : trimmed.split(/\\s+/);
  if (words.length < 4 || trimmed.length < 16) signals.push('short');
  if (
    AMBIGUOUS.test(prompt) ||
    (words.length > 0 && words.length < 6 && signals.filter((s) => s !== 'short').length === 0)
  ) {
    if (!signals.includes('ambiguous')) signals.push('ambiguous');
  }

  const riskCount = signals.filter(
    (s) =>
      s === 'payments' ||
      s === 'auth' ||
      s === 'migration' ||
      s === 'delete' ||
      s === 'production',
  ).length;

  let tier = 'cheap';
  if (
    riskCount >= 3 ||
    (signals.includes('production') &&
      (signals.includes('delete') || signals.includes('migration')))
  ) {
    tier = 'frontier';
  } else if (riskCount >= 1 || signals.includes('ambiguous') || signals.includes('short')) {
    tier = riskCount >= 2 ? 'frontier' : 'mid';
  }

  return { tier, signals: signals.slice(0, 5) };
}

`;
}

/** Dependency-free, advisory MCP stdio server; never logs task text. */
function mcpScript(): string {
  return `#!/usr/bin/env node
// Generated by JevLadder. Advisory only; no logging of task/diff text.
// jevladder_decide may call TypeSafe System One when a judge API key is set.
${miniatureScorer()}
${typesafeMcpJudgeSnippet(PLUGIN_VERSION)}
const tools = ['jevladder_decide', 'jevladder_route', 'jevladder_explain'].map((name) => ({
  name,
  description: name === 'jevladder_decide'
    ? 'Run an advisory miniature deterministic merge-gate check before CI/merge enforcement.'
    : name === 'jevladder_route'
      ? 'Suggest an advisory effort tier and signals for a coding task.'
      : 'Explain the advisory effort tier and signals for a coding task.',
  inputSchema: {
    type: 'object',
    properties: name === 'jevladder_decide'
      ? { diff: { type: 'string' }, testsPassed: { type: 'boolean' }, irreversible: { type: 'boolean' } }
      : { task: { type: 'string', minLength: 1 } },
    required: [name === 'jevladder_decide' ? 'diff' : 'task'],
    additionalProperties: false,
  },
}));
const content = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

async function decide(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.diff !== 'string' ||
      args.diff.length > 200000 ||
      (args.testsPassed !== undefined && typeof args.testsPassed !== 'boolean') ||
      (args.irreversible !== undefined && typeof args.irreversible !== 'boolean') ||
      Object.keys(args).some((key) => !['diff', 'testsPassed', 'irreversible'].includes(key))) return null;
  const result = (outcome, source, reason) => ({ outcome, source, reason });
  const diff = args.diff;
  if (args.testsPassed !== true) return result('block', 'rule:tests-not-green', 'Tests must pass before merge.');
  const lines = diff.split(String.fromCharCode(10));
  const fileHeaders = lines.filter((line) => line.startsWith('--- ') || line.startsWith('+++ '));
  if (!diff.trim() || fileHeaders.length === 0 || fileHeaders.some((line) => !/^(?:---|\\+\\+\\+) (?:[ab]\\/(?!\\/)|\\/dev\\/null)/.test(line))) {
    return result('human', 'judge', 'empty or malformed diff — insufficient evidence');
  }
  // Intentional miniature parity with merge-rules.ts protected glob defaults;
  // parse both sides so deletions cannot evade protection.
  const protectedPaths = fileHeaders
    .map((line) => line.slice(4).split('\\t')[0].replace(/^[ab]\\//, '').replaceAll(String.fromCharCode(92), '/'))
    .filter((path) => path !== '/dev/null');
  for (const path of protectedPaths) {
    const normalized = path.replace(/^\\.\\//, '').toLowerCase();
    const base = normalized.split('/').pop() || '';
    if (/(?:^|\\/)payments(?:\\/|$)/.test(normalized) ||
        /(?:^|\\/)auth(?:\\/|$)/.test(normalized) ||
        /(?:^|\\/)(?:auth-[^/]*|[^/]*-auth|auth\\.[^/]*)$/.test(normalized) ||
        /(?:^|\\/)(?:session-[^/]*|[^/]*-session|csrf[^/]*)$/.test(normalized) ||
        /(?:^|\\/)migrations(?:\\/|$)/.test(normalized) ||
        /(?:^|\\/)secrets(?:\\/|$)/.test(normalized) ||
        (base.startsWith('.env') && !/^\\.env\\.(?:example|sample|template|.*\\.(?:example|sample|template))$/i.test(base))) {
      return result('block', 'rule:protected-paths', 'Protected paths require review.');
    }
  }
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++ '));
  // Match the key/value, private-key, and known-prefix shapes from
  // SECRET_MATCHERS in merge-rules.ts. Never include matched text in output.
  const secretAssignment = (line) => {
    const match = line.slice(1).match(/(?:api[_-]?key|secret|password|token)\\s*[:=]\\s*(.*)/i);
    if (!match) return '';
    return match[1].trim().split(/[\\s,;#]/)[0].replace(/^[\\x27\\x22\\x60]+|[\\x27\\x22\\x60]+$/g, '');
  };
  const knownCredential = (body) =>
    /\\b(?:sk-|ghp_|xoxb-|glpat-)[A-Za-z0-9_-]{8,}|\\bAKIA[0-9A-Z]{16}\\b/.test(body);
  for (const line of added) {
    const body = line.slice(1);
    if (/BEGIN\\s+[A-Z ]*PRIVATE KEY/.test(body)) {
      return result('block', 'rule:secrets-in-diff', 'A credential-shaped value was added.');
    }
    if (knownCredential(body)) {
      return result('block', 'rule:secrets-in-diff', 'A credential-shaped value was added.');
    }
    const value = secretAssignment(line);
    if (!value || /^(?:YOUR_API_KEY_HERE|changeme|<[^>]*>)$/i.test(value)) continue;
    if (value.length >= 8 && /^[A-Za-z0-9_\\-./+=]+$/.test(value)) {
      return result('block', 'rule:secrets-in-diff', 'A credential-shaped value was added.');
    }
  }
  let inPackage = false;
  for (const line of diff.split(String.fromCharCode(10))) {
    if (line.startsWith('+++ ')) inPackage = line.slice(4).replaceAll(String.fromCharCode(92), '/').split('/').pop() === 'package.json';
    if (inPackage && line.startsWith('+') && !line.startsWith('+++') && line.includes(':') && line.includes('"') && !line.trimEnd().endsWith('{') && !line.trimEnd().endsWith('},') && !line.trimEnd().endsWith('],')) {
      return result('block', 'rule:new-dependencies', 'A package.json dependency entry was added.');
    }
  }
  if (diff.split(String.fromCharCode(10)).filter((line) => line.startsWith('+') || line.startsWith('-')).length > 2000) {
    return result('block', 'rule:diff-too-large', 'The diff exceeds the 2000 changed-line limit.');
  }
  if (diff.includes('TODO')) return result('human', 'judge', 'The miniature judge abstains on TODO changes.');
  if (args.irreversible === true) return result('human', 'judge', 'Irreversible changes require human review.');
  return await consultTypeSafeJudge(diff, args.irreversible === true);
}

async function handle(request) {
  const params = request.params;
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'jevladder', version: '${PLUGIN_VERSION}' },
      };
    case 'ping': return {};
    case 'tools/list': return { tools };
    case 'tools/call': {
      if (!tools.some((tool) => tool.name === params?.name)) {
        return content('Unknown JevLadder tool.', true);
      }
      if (params.name === 'jevladder_decide') {
        const decision = await decide(params?.arguments);
        return decision ? content(JSON.stringify(decision)) : content('Invalid jevladder_decide arguments.', true);
      }
      const task = params?.arguments?.task;
      if (typeof task !== 'string' || task.length < 1 || task.length > 20000) {
        return content('task must be a string of 1 to 20000 characters.', true);
      }
      const route = scorePrompt(task);
      if (params.name === 'jevladder_route') return content(JSON.stringify(route));
      return content(JSON.stringify(route) + '\\n' + [
        'Suggested effort tier: ' + route.tier + '.',
        'Signals: ' + (route.signals.join(', ') || 'none; start cheap for well-scoped work') + '.',
        'Escalate one tier when verification is weak or uncertainty remains.',
        'Advisory only: a tier is never permission; irreversible actions require human review.',
      ].join('\\n'));
    }
    default: return undefined;
  }
}

const MAX_LINE_BYTES = 256 * 1024;
let pending = Buffer.alloc(0);
let discarding = false;
try {
for await (const chunk of process.stdin) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  let offset = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset);
    const end = newline < 0 ? bytes.length : newline;
    const part = bytes.subarray(offset, end);
    if (discarding) {
      if (newline < 0) break;
      discarding = false;
      pending = Buffer.alloc(0);
      offset = newline + 1;
      continue;
    }
    if (pending.length + part.length > MAX_LINE_BYTES) {
      pending = Buffer.alloc(0);
      if (newline < 0) break;
      offset = newline + 1;
      continue;
    }
    if (part.length > 0) pending = pending.length === 0 ? Buffer.from(part) : Buffer.concat([pending, part]);
    if (newline < 0) break;
    const line = pending.toString('utf8');
    pending = Buffer.alloc(0);
    try {
    const request = JSON.parse(line);
    if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0') {
      offset = newline + 1;
      continue;
    }
    // Notifications (including notifications/initialized) never receive a response.
    if (!Object.hasOwn(request, 'id') || (typeof request.id !== 'string' && !(typeof request.id === 'number' && Number.isFinite(request.id)))) {
      offset = newline + 1;
      continue;
    }
    const result = await handle(request);
    const response = result === undefined
      ? { error: { code: -32601, message: 'Method not found' } }
      : result?.error
        ? { error: result.error }
      : { result };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\\n');
  } catch {
    // Malformed lines are ignored; later requests remain usable. Never echo input.
  }
    offset = newline + 1;
  }
}
} catch {
  // A closed or failed stdin ends the advisory server quietly.
}
`;
}

/**
 * Standalone Node ESM observe hook. Embedded as a string so the generated
 * plugin runs without depending on the jevladder package at hook time.
 * Generated file — do not edit; mirrors scoreRoute signals in miniature.
 *
 * Log path priority: `JEVLADDER_OBSERVE_LOG` (full path) wins; else `~/.jevladder/<logFileName>`.
 */
function observeScript(logFileName: string): string {
  const embeddedName = JSON.stringify(logFileName);
  return `#!/usr/bin/env node
// Generated by \`jevladder plugin\` — do not edit.
// Mirrors scoreRoute signals in miniature (risk words, ambiguity, length).
// Observe-only: never exits non-zero, never prints a blocking decision.
// Log path: JEVLADDER_OBSERVE_LOG (env) wins over ~/.jevladder/${logFileName}.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_LOG_BASENAME = ${embeddedName};

async function readAllStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 256 * 1024) return null;
    chunks.push(buffer.toString('utf8'));
  }
  return chunks.join('');
}

${miniatureScorer()}

function logPath() {
  // Env override always wins over the configured basename.
  const fromEnv = process.env.JEVLADDER_OBSERVE_LOG;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return join(homedir(), '.jevladder', DEFAULT_LOG_BASENAME);
}

${mergeLikeSource()}
function main() {
  return readAllStdin()
    .then((raw) => {
      if (raw === null) return; // Oversized host payload: silent fail-open, no partial parse.
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return; // garbage stdin: exit 0, print nothing
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;

      const hookEventName =
        typeof parsed.hook_event_name === 'string'
          ? parsed.hook_event_name
          : typeof parsed.hookEventName === 'string'
            ? parsed.hookEventName
            : '';

      if (hookEventName === 'SessionStart') {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'SessionStart',
              additionalContext:
                'JevLadder is active automatically with sensible defaults; no setup or commands are needed. For specific, well-scoped coding tasks (such as fixing a test, adding a field, or writing a function that follows a neighbouring pattern), start with cheap effort and automatically delegate when the host supports it. Use jevladder_route or jevladder_explain MCP tools when available to size the task. Before merge, use jevladder_decide as an advisory pre-merge check; enforcement stays in CI/merge. In Claude Code, delegate to jevladder:jevladder-cheap first. If that tier fails or verification is weak, keep the error output and escalate one tier at a time: cheap, mid, frontier (Claude Code agents: jevladder:jevladder-mid, then jevladder:jevladder-frontier). Reserve frontier for cross-cutting work, unclear causes, or orchestration. A tier is never permission: irreversible or uncertain actions go to a human. The main session model is never swapped.',
            },
          }) + '\\n',
        );
        return;
      }

      if (hookEventName === 'PreToolUse') {
        const toolName = typeof parsed.tool_name === 'string' ? parsed.tool_name : '';
        const toolInput =
          parsed.tool_input !== null &&
          typeof parsed.tool_input === 'object' &&
          !Array.isArray(parsed.tool_input)
            ? parsed.tool_input
            : {};
        const command = typeof toolInput.command === 'string' ? toolInput.command : '';
        const writeTool =
          toolName === 'Write' ||
          toolName === 'Edit' ||
          toolName === 'MultiEdit' ||
          toolName === 'NotebookEdit' ||
          toolName === 'apply_patch';
        const kind = writeTool
          ? 'write'
          : (toolName === 'Bash' || toolName === 'shell') && mergeLike(command)
            ? 'merge'
            : '';
        if (kind === '') return;

        const additionalContext =
          kind === 'merge'
            ? 'jevladder observe: PreToolUse merge-like command. Advisory only; this hook does not approve or deny. Irreversible merge and push actions need a human. Enforcement stays in CI/merge. Use jevladder_decide before merge when available.'
            : 'jevladder observe: PreToolUse file write. Advisory only; this hook does not approve or deny the edit. A file write is not merge approval. Before merge, use jevladder_decide; enforcement stays in CI/merge. Irreversible or uncertain changes go to a human.';
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext,
            },
          }) + '\\n',
        );
        return;
      }

      // Host hook input includes hook_event_name; eventless legacy payloads
      // remain UserPromptSubmit-compatible for existing callers/tests.
      if (hookEventName !== '' && hookEventName !== 'UserPromptSubmit') return;

      const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : '';
      const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : '';
      const sessionId =
        typeof parsed.session_id === 'string'
          ? parsed.session_id
          : typeof parsed.sessionId === 'string'
            ? parsed.sessionId
            : '';

      const { tier, signals } = scorePrompt(prompt);
      const entry = {
        ts: new Date().toISOString(),
        session_id: sessionId,
        cwd,
        tier,
        signals,
        promptChars: prompt.length,
      };

      try {
        const optOut = process.env.JEVLADDER_NO_LOG;
        if (optOut !== '1' && optOut !== 'true') {
          const path = logPath();
          mkdirSync(dirname(path), { recursive: true });
          if (existsSync(path) && statSync(path).size >= 1024 * 1024) {
            renameSync(path, path + '.1');
          }
          appendFileSync(path, JSON.stringify(entry) + '\\n', 'utf8');
        }
      } catch {
        // still annotate; never fail the hook
      }

      const signalList = signals.length === 0 ? 'none' : signals.join(',');
      const additionalContext =
        'jevladder observe: tier=' +
        tier +
        ' signals=' +
        signalList +
        ' Claude Code suggested subagent=jevladder:jevladder-' +
        tier +
        ' (advisory delegation only; observe-only, no action taken; main session model unchanged)';
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext,
          },
        }) + '\\n',
      );
    })
    .catch(() => {
      // never non-zero
    });
}

main();
`;
}

/**
 * OpenCode plugin module. Named export only, so the host does not register the
 * same function twice. Advisory: no permission denial and no tool-arg rewrite.
 */
function opencodePlugin(logFileName: string): string {
  const embeddedName = JSON.stringify(logFileName);
  return `// Generated by \`jevladder plugin\` — do not edit.
// OpenCode host adapter. Advisory only: never throws, never rewrites tool
// arguments, never sets a permission denial, never logs prompt or tool text.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = join(PLUGIN_ROOT, '..', 'scripts', 'jevladder-mcp.mjs');
const SKILLS_DIR = join(PLUGIN_ROOT, '..', 'skills');
const DEFAULT_LOG_BASENAME = ${embeddedName};
const SESSION_GUIDANCE = 'JevLadder is advisory on OpenCode. Start specific, well-scoped coding tasks at cheap effort and escalate one tier at a time when verification is weak. A tier is not permission. Irreversible or uncertain actions go to a human. Before merge, use jevladder_decide when the local MCP server is available; enforcement stays in CI/merge. This adapter never blocks a tool call.';

${miniatureScorer()}
${mergeLikeSource()}
function logPath() {
  const fromEnv = process.env.JEVLADDER_OBSERVE_LOG;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return join(homedir(), '.jevladder', DEFAULT_LOG_BASENAME);
}

function guard(fn) {
  return async function guarded(...args) {
    try {
      await fn(...args);
    } catch {
      // fail-open: a broken advisory hook must not block the host
    }
  };
}

function promptText(parts) {
  if (!Array.isArray(parts)) return '';
  let text = '';
  for (const part of parts) {
    if (!part || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string') continue;
    if (part.text.startsWith('jevladder observe:')) continue;
    text += part.text;
    if (text.length >= 8000) return text.slice(0, 8000);
  }
  return text;
}

function toolKind(tool, args) {
  const name = typeof tool === 'string' ? tool.toLowerCase() : '';
  const command = args && typeof args === 'object' && typeof args.command === 'string' ? args.command : '';
  if (name === 'write' || name === 'edit' || name === 'multiedit' || name === 'apply_patch' || name === 'patch') {
    return 'write';
  }
  if ((name === 'bash' || name === 'shell') && mergeLike(command)) return 'merge';
  return '';
}

function remember(cwd, sessionId, tier, signals, promptChars) {
  try {
    const optOut = process.env.JEVLADDER_NO_LOG;
    if (optOut === '1' || optOut === 'true') return;
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size >= 1024 * 1024) renameSync(path, path + '.1');
    const entry = { ts: new Date().toISOString(), session_id: sessionId, cwd, tier, signals, promptChars };
    appendFileSync(path, JSON.stringify(entry) + '\\n', 'utf8');
  } catch {
    // still advise
  }
}

export const JevLadderPlugin = async (ctx) => {
  const cwd = ctx && typeof ctx.directory === 'string' ? ctx.directory : '';
  return {
    config: guard(async (config) => {
      if (!config || typeof config !== 'object' || Array.isArray(config)) return;
      const mcp = config.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp) ? config.mcp : {};
      config.mcp = mcp;
      const servers = mcp.servers && typeof mcp.servers === 'object' && !Array.isArray(mcp.servers) ? mcp.servers : {};
      mcp.servers = servers;
      if (!Object.prototype.hasOwnProperty.call(servers, 'jevladder')) {
        servers.jevladder = { type: 'local', command: ['node', MCP_SCRIPT] };
      }
      if (Array.isArray(config.skills)) {
        if (!config.skills.includes(SKILLS_DIR)) config.skills.push(SKILLS_DIR);
      } else if (config.skills && typeof config.skills === 'object' && Array.isArray(config.skills.paths)) {
        if (!config.skills.paths.includes(SKILLS_DIR)) config.skills.paths.push(SKILLS_DIR);
      } else if (config.skills === undefined) {
        config.skills = [SKILLS_DIR];
      }
    }),
    'experimental.chat.system.transform': guard(async (_input, output) => {
      if (!output || typeof output !== 'object' || Array.isArray(output)) return;
      if (typeof output.system === 'string') return;
      if (!Array.isArray(output.system)) output.system = [];
      if (output.system.some((line) => typeof line === 'string' && line.includes('JevLadder is advisory on OpenCode'))) return;
      output.system.push(SESSION_GUIDANCE);
    }),
    'chat.message': guard(async (input, output) => {
      if (!output || typeof output !== 'object' || !Array.isArray(output.parts)) return;
      if (output.parts.some((part) => part && typeof part.text === 'string' && part.text.startsWith('jevladder observe: tier='))) return;
      const prompt = promptText(output.parts);
      if (prompt.trim() === '') return;
      const { tier, signals } = scorePrompt(prompt);
      const sessionId = input && typeof input.sessionID === 'string' ? input.sessionID : '';
      remember(cwd, sessionId, tier, signals, prompt.length);
      const signalList = signals.length === 0 ? 'none' : signals.join(',');
      output.parts.push({
        type: 'text',
        text: 'jevladder observe: tier=' + tier + ' signals=' + signalList + '. Advisory only on OpenCode; a tier is not permission. Enforcement stays in CI/merge.',
      });
    }),
    'tool.execute.before': guard(async () => {
      // No context channel on this hook. Do not rewrite args and do not throw.
    }),
    'tool.execute.after': guard(async (input, output) => {
      if (!output || typeof output !== 'object' || typeof output.output !== 'string') return;
      const kind = toolKind(input && input.tool, input && input.args);
      if (kind === '') return;
      if (output.output.includes('jevladder observe: OpenCode')) return;
      const note = kind === 'merge'
        ? 'jevladder observe: OpenCode merge-like command. Advisory only; this hook does not approve or deny. Irreversible merge and push actions need a human. Enforcement stays in CI/merge.'
        : 'jevladder observe: OpenCode file write. Advisory only; this hook does not approve or deny the edit. A file write is not merge approval. Enforcement stays in CI/merge.';
      output.output += '\\n' + note;
    }),
  };
};
`;
}

/** Host-neutral routing guidance (Cursor rules, ZCode AGENTS fragment, bundled skill). */
export function jevladderRoutingGuidance(): string {
  return `# JevLadder routing (advisory)

JevLadder sizes coding tasks and suggests effort tiers. Call \`jevladder_route\` or
\`jevladder_explain\` when the local MCP server is available. Before merge, use
\`jevladder_decide\` as an advisory pre-merge check; enforcement stays in CI/merge.

Start specific, well-scoped work at **cheap** effort. If verification is weak or a
tier fails, keep the error output and escalate **one tier at a time**: cheap → mid →
frontier. Reserve frontier for cross-cutting work, unclear causes, or orchestration.

A tier is never permission. Irreversible or uncertain actions go to a human; the judge
never solely approves irreversible actions. The main session model is never swapped.
`;
}

/**
 * Cursor project files under \`.cursor/\`. MCP launches the bundled stdio server via
 * a workspace-relative path; no secrets in JSON (judge keys come from the user env).
 */
export function buildCursorHostFiles(): Record<string, string> {
  const mcpScriptArg = `\${workspaceFolder}/${CURSOR_BUNDLED_MCP_REL}`;
  const mcp = {
    mcpServers: {
      jevladder: {
        command: 'node',
        args: [mcpScriptArg],
      },
    },
  };
  const rule = `---
description: JevLadder advisory coding effort routing — cheap first, escalate on weak verification, humans for irreversible work.
alwaysApply: true
---

${jevladderRoutingGuidance()}`;
  const bundledMcp = mcpScript();
  return {
    '.cursor/mcp.json': `${JSON.stringify(mcp, null, 2)}\n`,
    '.cursor/rules/jevladder.mdc': rule.endsWith('\n') ? rule : `${rule}\n`,
    [CURSOR_BUNDLED_MCP_REL]: bundledMcp.endsWith('\n') ? bundledMcp : `${bundledMcp}\n`,
  };
}

/**
 * ZCode install fragments under a `zcode/` directory. When `zcodeRootAbs` is set
 * (CLI `--host zcode`), `mcp-servers.json` uses an absolute path to the bundled
 * MCP script so global `~/.zcode/cli/config.json` can launch it. The bundled
 * plugin template omits `zcodeRootAbs` and uses a path relative to the `zcode/`
 * folder — regenerate with the CLI before merging into global config.
 */
export function buildZcodeHostFiles(zcodeRootAbs?: string): Record<string, string> {
  const mcpScriptPath = zcodeRootAbs !== undefined
    ? join(zcodeRootAbs, ZCODE_BUNDLED_MCP_REL)
    : `./${ZCODE_BUNDLED_MCP_REL}`;
  const mcpServers = {
    mcp: {
      servers: {
        jevladder: {
          command: 'node',
          args: [mcpScriptPath],
        },
      },
    },
  };
  const agents = jevladderRoutingGuidance();
  const bundledMcp = mcpScript();
  return {
    'mcp-servers.json': `${JSON.stringify(mcpServers, null, 2)}\n`,
    'AGENTS.jevladder.md': agents.endsWith('\n') ? agents : `${agents}\n`,
    [ZCODE_BUNDLED_MCP_REL]: bundledMcp.endsWith('\n') ? bundledMcp : `${bundledMcp}\n`,
  };
}

/** Write ZCode host files under \`outDir/zcode/\` (never touches home config). */
export function writeZcodeHostFiles(outDir: string): string[] {
  const zcodeRoot = join(outDir, 'zcode');
  const files = buildZcodeHostFiles(zcodeRoot);
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(zcodeRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    written.push(abs);
  }
  return written;
}

/** Write Cursor host files (\`.cursor/mcp.json\`, rules, bundled MCP) under \`outDir\`. */
export function writeCursorHostFiles(outDir: string): string[] {
  const files = buildCursorHostFiles();
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(outDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    written.push(abs);
  }
  return written;
}

function pluginReadme(logFileName: string, models: Record<RouteTier, ClaudeCodeModelAlias>): string {
  return `# JevLadder — Codex-first advisory plugin

Version ${PLUGIN_VERSION}. JevLadder is active automatically with sensible defaults;
no CLI commands are needed after installation and hook trust review.
SessionStart provides automatic delegation guidance, and UserPromptSubmit adds an advisory route tier.
PreToolUse adds advisory context before file writes and merge-like shell commands.
It never approves or denies the tool call. Never blocks or changes the main session model.

## Install

Install from the JevLadder marketplace in Codex:

\`\`\`bash
codex plugin marketplace add HaraldSigvartsen/jevladder
codex plugin add jevladder@jevladder
\`\`\`

Then just use Codex normally. Codex asks you to review/trust the plugin's hooks
once (\`/hooks\`); this is Codex's safety prompt, not config editing. The bundled
MCP server needs Node and exposes voluntary \`jevladder_decide\`, \`jevladder_route\` /
\`jevladder_explain\` tools; it logs no task or diff text. \`jevladder_decide\` is an
advisory miniature pre-merge check; enforcement stays in CI/merge.

## What it does

On \`SessionStart\`, supplies concise routing guidance: automatically delegate
specific, well-scoped coding tasks at cheap effort when the host supports it;
keep error output and escalate one tier at a time to mid then frontier when work fails or
verification is weak. Reserve frontier for cross-cutting, unclear-cause, or
orchestration work. A tier is never permission; irreversible or uncertain work
goes to a human, and the main session model is never swapped.

On \`UserPromptSubmit\`, runs \`scripts/jevladder-observe.mjs\`:

1. Scores the prompt with simple signals (payments / auth / migration /
   delete / production, ambiguity, length) → tier \`cheap\` | \`mid\` |
   \`frontier\`.
2. Appends one JSON line to the observe log (tier, signals, prompt length —
   never the full prompt text).
3. Prints advisory routing context; the host performs any delegation.

On \`PreToolUse\` for \`Write\`, \`Edit\`, \`MultiEdit\`, \`NotebookEdit\`, \`apply_patch\`, and
\`Bash\`, the same script prints advisory context for file writes and for
merge-like commands (\`git merge\`, \`git push\`, \`git rebase\`, \`gh pr merge\`).
Other shell commands produce no output. The hook does not log tool input,
file contents, or command text, and it never sets \`permissionDecision\`.

The hook launcher checks for Node and exits silently with status 0 when Node is
unavailable, so plugin loading remains fail-open. The CLI is not needed for
normal use.

## Claude Code (secondary host)

Install using \`/plugin marketplace add HaraldSigvartsen/jevladder\`, then
\`/plugin install jevladder@jevladder\`. The agents below are Claude-only; Codex custom
agents are TOML in ~/.codex/agents and are not bundled by this plugin.

### Subagent models

| Tier | Agent | Claude Code model alias |
| --- | --- | --- |
| cheap | jevladder-cheap | ${models.cheap} |
| mid | jevladder-mid | ${models.mid} |
| frontier | jevladder-frontier | ${models.frontier} |

Set \`subagentModels\` in the JSON passed to \`--config\` (or in
\`JevLadderPluginConfig\` passed to \`buildPluginFiles\` / \`writePluginFiles\`).
Allowed aliases: \`haiku\`, \`sonnet\`, \`opus\`, \`inherit\`; omitted tiers default
to haiku / sonnet / inherit. \`inherit\` uses the main session's model for the
subagent; it does not guarantee a frontier-class model or a lower cost.
Aliases are baked into agent frontmatter at generation time; regenerate after
config changes. Editing the emitted \`config.json\` does not change agent models.

## OpenCode (additional host)

\`opencode/jevladder.mjs\` exports \`JevLadderPlugin\`. Place that file at
\`.opencode/plugins/jevladder.mjs\` (this repository already does, via a
re-export). OpenCode then gets advisory system guidance, a route tier on user
text, and a note after file-write or merge-like shell tools. The \`config\` hook
adds the local \`jevladder\` MCP server and this plugin's \`skills\` directory
only when those entries are absent. Tool arguments are not rewritten, and no
permission is denied. Prompt text and tool input are not logged.

This is structural support, validated by loading the module and simulating
hooks. It is not a claim that a live OpenCode session was run.

## Cursor (additional host)

Copy the generated \`cursor/.cursor/\` tree into your project root (or run
\`jevladder plugin --host cursor --out .\` from the repo root after
\`pnpm run build\`). That writes \`.cursor/mcp.json\`,
\`.cursor/rules/jevladder.mdc\`, and a self-contained
\`.cursor/jevladder/jevladder-mcp.mjs\` (same source as \`scripts/jevladder-mcp.mjs\`
in the full plugin). The MCP entry launches that bundled script; no separate
\`plugin/\` directory is required. No secrets are stored in these files;
\`jevladder_decide\` reads \`JEVLADDER_TYPESAFE_API_KEY\` or
\`TYPESAFE_API_KEY\` from the environment and fails closed without a key.

The project rule carries host-neutral cheap-first routing guidance. Cursor
lifecycle hooks are **not** bundled yet (the shared observe script targets
Codex/Claude hook payloads). Enforcement stays in CI/merge.

This is structural support, validated by generation tests. It is not a claim
that a live Cursor session was run.

## ZCode (additional host)

Run \`jevladder plugin --host zcode --out <dir>\` (after \`pnpm run build\`). That
writes \`<dir>/zcode/mcp-servers.json\` (an \`mcp.servers\` fragment with an
**absolute** path to the bundled stdio MCP), \`<dir>/zcode/AGENTS.jevladder.md\`
(cheap-first routing guidance), and \`<dir>/zcode/jevladder/jevladder-mcp.mjs\`.
Merge the \`mcp\` object from the fragment into \`~/.zcode/cli/config.json\`
and append the guidance file to \`~/.zcode/AGENTS.md\`. The generator never
reads or writes your home \`.zcode\` tree. No secrets are stored in these files;
judge keys come from the environment. ZCode lifecycle hooks are not bundled;
enforcement stays in CI/merge.

## T3 Code

T3 Code drives the Codex and Claude Code agents. Use the existing Codex and
Claude Code plugin outputs there. T3 Code itself has not been tested with
JevLadder.

## What it does NOT do

- Does **not** block prompts or tool use. PreToolUse and the OpenCode adapter are context only.
- Does **not** swap the host model mid-session (a plugin cannot do that —
  see the main jevladder README honesty section).
- Does **not** send prompt text anywhere. The bundled MCP \`jevladder_decide\` tool
  calls the TypeSafe judge API only when \`JEVLADDER_TYPESAFE_API_KEY\` or
  \`TYPESAFE_API_KEY\` is set; otherwise it defers to a human (fail closed).
  OpenAI-compatible judges use \`JEVLADDER_JUDGE_API_KEY\` only — keys are never
  shared across providers.

## Log location and privacy

- Default: \`~/.jevladder/${logFileName}\` (configured basename; path segments and
  weird names are sanitized to \`${DEFAULT_LOG_FILE}\`).
- Override (wins): set env \`JEVLADDER_OBSERVE_LOG\` to any file path — the env
  value always takes priority over the configured basename.
- Each line is \`{ts, session_id, cwd, tier, signals, promptChars}\` —
  **no prompt text** is written.

## Uninstall

Remove the plugin directory from your Claude Code plugins location, and delete
\`~/.jevladder\` if you no longer want local observe logs. For Cursor, remove
the generated \`.cursor/mcp.json\`, \`.cursor/rules/jevladder.mdc\`, and
\`.cursor/jevladder/\` tree.
`;
}

/** Build the relative path → file content map for the observe-only plugin. */
export function buildPluginFiles(
  config: JevLadderPluginConfig = {},
): Record<string, string> {
  config = parseJevLadderPluginConfig(config);
  const protectedPaths = config.protectedPaths ?? [];
  const logFileName = sanitizeLogFileName(config.logFileName);
  const subagentModels = { ...DEFAULT_SUBAGENT_MODELS, ...config.subagentModels };

  const pluginJson = {
    name: 'jevladder',
    version: PLUGIN_VERSION,
    description:
      'JevLadder observe-only decision log and advisory subagent routing. Never blocks or changes the main session model.',
    icon: './assets/icon.png',
    author: { name: 'Harald Sigvartsen' },
  };

  const codexPluginJson = {
    name: 'jevladder',
    version: PLUGIN_VERSION,
    description: 'Codex-first automatic advisory routing, lifecycle guidance, and voluntary MCP decide/route/explain tools. Never blocks or swaps the main model.',
    author: { name: 'Harald Sigvartsen' },
    homepage: 'https://github.com/HaraldSigvartsen/jevladder',
    repository: 'https://github.com/HaraldSigvartsen/jevladder',
    license: 'MIT',
    skills: './skills/',
    hooks: './hooks/hooks.json',
    mcpServers: './.mcp.json',
    interface: {
      displayName: 'JevLadder',
      shortDescription: 'Cheap-first advisory routing for Codex.',
      longDescription: 'Automatic lifecycle guidance and a routing skill, with voluntary local MCP decide/route/explain tools. Escalate uncertainty; humans approve irreversible actions. Claude Code supported as second host. OpenCode and Cursor supported as additional hosts.',
      developerName: 'Harald Sigvartsen',
      category: 'Developer Tools',
      capabilities: ['Instructions', 'Lifecycle hooks'],
      defaultPrompt: ['Size this coding task with JevLadder.', 'Explain the recommended effort tier.', 'Start cheap and escalate when verification is weak.'],
      composerIcon: './assets/icon.png',
      logo: './assets/icon.png',
    },
  };

  const hooksJson = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/jevladder-hook.sh"',
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/jevladder-hook.sh"',
              timeout: 5,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Write|Edit|MultiEdit|NotebookEdit|apply_patch|Bash',
          hooks: [
            {
              type: 'command',
              command: 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/jevladder-hook.sh"',
              timeout: 5,
            },
          ],
        },
      ],
    },
  };

  const configJson = {
    protectedPaths,
    irreversibleActions: [...IRREVERSIBLE_ACTIONS],
    observeOnly: true as const,
    subagentModels,
    ...(config.logFileName !== undefined ? { logFileName } : {}),
  };

  const script = observeScript(logFileName);
  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none">
  <rect x="2" y="2" width="60" height="60" rx="15" fill="#1E1B2E"/>
  <path d="M15 47h10V37H15zM27 47h10V29H27zM39 47h10V21H39z" fill="#6D5BD0"/>
  <path d="M17 27c2-7 7-10 13-9 5 1 7 5 7 10" stroke="#6D5BD0" stroke-width="4" stroke-linecap="round"/>
</svg>
`;

  return {
    'assets/icon.svg': iconSvg,
    '.codex-plugin/plugin.json': `${JSON.stringify(codexPluginJson, null, 2)}\n`,
    '.mcp.json': `${JSON.stringify({ mcpServers: { jevladder: { command: 'node', args: ['./scripts/jevladder-mcp.mjs'], cwd: '.' } } }, null, 2)}\n`,
    'scripts/jevladder-mcp.mjs': mcpScript(),
    '.claude-plugin/plugin.json': `${JSON.stringify(pluginJson, null, 2)}\n`,
    'hooks/hooks.json': `${JSON.stringify(hooksJson, null, 2)}\n`,
    'scripts/jevladder-hook.sh': '#!/bin/sh\nif ! command -v node >/dev/null 2>&1; then\n  exit 0\nfi\nDIR=$(dirname "$0")\nexec node "$DIR/jevladder-observe.mjs"\n',
    'scripts/jevladder-observe.mjs': script.endsWith('\n') ? script : `${script}\n`,
    'opencode/jevladder.mjs': `${opencodePlugin(logFileName).replace(/\n$/, '')}\n`,
    ...Object.fromEntries(
      Object.entries(buildCursorHostFiles()).map(([rel, content]) => [`cursor/${rel}`, content]),
    ),
    ...Object.fromEntries(
      Object.entries(buildZcodeHostFiles()).map(([rel, content]) => [`zcode/${rel}`, content]),
    ),
    'skills/jevladder-routing/SKILL.md': `---
name: jevladder-routing
description: Applies automatically when delegating or choosing effort for coding tasks.
---

# JevLadder routing

JevLadder provides advisory routing for Codex first, with Claude Code also supported.
Call \`jevladder_route\` or \`jevladder_explain\` to size a task. Before merge, use \`jevladder_decide\` as an advisory pre-merge check when available; enforcement stays in CI/merge.
PreToolUse adds advisory context before a file write or a merge-like shell command. It does not approve or deny the tool.
Start specific, well-scoped coding work at cheap effort; delegate automatically
when the host supports it and its instructions allow delegation.

If a tier fails or verification is weak, preserve the error output and escalate
one tier at a time: cheap → mid → frontier. Abstention and uncertainty escalate
up. Reserve frontier for cross-cutting work, unclear causes, or orchestration.
Claude Code can use \`jevladder:jevladder-cheap\`, \`jevladder:jevladder-mid\`, and
\`jevladder:jevladder-frontier\`. The bundled agents/*.md are Claude-only; Codex custom
agents live in ~/.codex/agents as TOML and are not bundled here.

A tier is never permission. Irreversible or uncertain actions go to a human;
the judge never solely approves irreversible actions. Enforcement belongs in
CI/merge outside this session. The main session model is never swapped.
`,
    'config.json': `${JSON.stringify(configJson, null, 2)}\n`,
    'README.md': pluginReadme(logFileName, subagentModels),
    ...Object.fromEntries(
      (Object.keys(subagentModels) as RouteTier[]).map((tier) => [
        `agents/jevladder-${tier}.md`,
        `---
name: jevladder-${tier}
description: Handles delegated ${tier}-tier tasks when JevLadder suggests jevladder-${tier}. Advisory only; the host decides whether to delegate.
model: ${subagentModels[tier]}
---

You are JevLadder's ${tier}-tier subagent. Work only on the task delegated by the host.
JevLadder routing is advisory; a tier is not permission to perform an action.
Follow the host's instructions, permission rules, and project policies.
If the task exceeds your capability or involves uncertain or irreversible
actions, report the concern to the host for human review. Do not treat the
route suggestion as approval. Return a concise result and what you verified.
`,
      ]),
    ),
  };
}

/** Write plugin files under \`outDir\`, creating parent directories as needed. */
export function writePluginFiles(outDir: string, config: JevLadderPluginConfig = {}): string[] {
  const files = buildPluginFiles(config);
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(outDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    written.push(abs);
  }
  return written;
}
