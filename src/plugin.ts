/**
 * Codex-first, dual-host advisory plugin generator (v0.4 automatic layer).
 *
 * Emits a loadable plugin directory: manifest, UserPromptSubmit hook,
 * standalone observe script, config, and README. The hook annotates prompts
 * with a miniature route tier — it never blocks and never changes models.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RouteTier } from './route.js';

export type ClaudeCodeModelAlias = 'haiku' | 'sonnet' | 'opus' | 'inherit';

export interface JevPluginConfig {
  /** Glob patterns copied into generated config.json (informational for now). */
  protectedPaths?: string[];
  /**
   * Preferred observe log basename under `~/.jev/`.
   * Sanitized to a single path segment (slashes stripped); weird input falls
   * back to {@link DEFAULT_LOG_FILE}. Env `JEV_OBSERVE_LOG` always wins over
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
export function parseJevPluginConfig(raw: unknown): JevPluginConfig {
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
    subagentModels: config.subagentModels as JevPluginConfig['subagentModels'],
  };
}

const PLUGIN_VERSION = '0.4.0';
export const DEFAULT_LOG_FILE = 'observe.jsonl';
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
// Generated by Jev. Advisory only; no logging or remote calls.
import { createInterface } from 'node:readline';

${miniatureScorer()}
const tools = ['jev_route', 'jev_explain'].map((name) => ({
  name,
  description: name === 'jev_route'
    ? 'Suggest an advisory effort tier and signals for a coding task.'
    : 'Explain the advisory effort tier and signals for a coding task.',
  inputSchema: {
    type: 'object',
    properties: { task: { type: 'string', minLength: 1 } },
    required: ['task'],
    additionalProperties: false,
  },
}));
const content = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

function handle(request) {
  const params = request.params;
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'jev', version: '${PLUGIN_VERSION}' },
      };
    case 'ping': return {};
    case 'tools/list': return { tools };
    case 'tools/call': {
      if (!tools.some((tool) => tool.name === params?.name)) return content('Unknown Jev tool.', true);
      const task = params?.arguments?.task;
      if (typeof task !== 'string' || task.trim() === '') return content('task must be a non-empty string.', true);
      const route = scorePrompt(task);
      if (params.name === 'jev_route') return content(JSON.stringify(route));
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

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  try {
    const request = JSON.parse(line);
    if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0') return;
    // Notifications (including notifications/initialized) never receive a response.
    if (!Object.hasOwn(request, 'id')) return;
    if (typeof request.id !== 'string' && !(typeof request.id === 'number' && Number.isFinite(request.id))) return;
    const result = handle(request);
    const response = result === undefined
      ? { error: { code: -32601, message: 'Method not found' } }
      : { result };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\\n');
  } catch {
    // Malformed lines are ignored; later requests remain usable. Never echo input.
  }
});
lines.on('error', () => {});
`;
}

/**
 * Standalone Node ESM observe hook. Embedded as a string so the generated
 * plugin runs without depending on the jev package at hook time.
 * Generated file — do not edit; mirrors scoreRoute signals in miniature.
 *
 * Log path priority: `JEV_OBSERVE_LOG` (full path) wins; else `~/.jev/<logFileName>`.
 */
function observeScript(logFileName: string): string {
  const embeddedName = JSON.stringify(logFileName);
  return `#!/usr/bin/env node
// Generated by \`jev plugin\` — do not edit.
// Mirrors scoreRoute signals in miniature (risk words, ambiguity, length).
// Observe-only: never exits non-zero, never prints a blocking decision.
// Log path: JEV_OBSERVE_LOG (env) wins over ~/.jev/${logFileName}.

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_LOG_BASENAME = ${embeddedName};

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  }
  return chunks.join('');
}

${miniatureScorer()}

function logPath() {
  // Env override always wins over the configured basename.
  const fromEnv = process.env.JEV_OBSERVE_LOG;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return join(homedir(), '.jev', DEFAULT_LOG_BASENAME);
}

function main() {
  return readAllStdin()
    .then((raw) => {
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
                'Jev is active automatically with sensible defaults; no setup or commands are needed. For specific, well-scoped coding tasks (such as fixing a test, adding a field, or writing a function that follows a neighbouring pattern), start with cheap effort and automatically delegate when the host supports it. Use jev_route or jev_explain MCP tools when available to size the task. In Claude Code, delegate to jev:jev-cheap first. If that tier fails or verification is weak, keep the error output and escalate one tier at a time: cheap, mid, frontier (Claude Code agents: jev:jev-mid, then jev:jev-frontier). Reserve frontier for cross-cutting work, unclear causes, or orchestration. A tier is never permission: irreversible or uncertain actions go to a human. The main session model is never swapped.',
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
        const path = logPath();
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, JSON.stringify(entry) + '\\n', 'utf8');
      } catch {
        // still annotate; never fail the hook
      }

      const signalList = signals.length === 0 ? 'none' : signals.join(',');
      const additionalContext =
        'jev observe: tier=' +
        tier +
        ' signals=' +
        signalList +
        ' Claude Code suggested subagent=jev:jev-' +
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

function pluginReadme(logFileName: string, models: Record<RouteTier, ClaudeCodeModelAlias>): string {
  return `# Jev — Codex-first advisory plugin

Version ${PLUGIN_VERSION}. Jev is active automatically with sensible defaults;
no CLI commands are needed after installation and hook trust review.
SessionStart provides automatic delegation guidance, and UserPromptSubmit adds an advisory route tier.
Never blocks or changes the main session model.

## Install

Install from the Jev marketplace in Codex:

\`\`\`bash
codex plugin marketplace add HaraldSigvartsen/jev
codex plugin add jev@jev
\`\`\`

Then just use Codex normally. Codex asks you to review/trust the plugin's hooks
once (\`/hooks\`); this is Codex's safety prompt, not config editing. The bundled
MCP server needs Node and exposes voluntary \`jev_route\` / \`jev_explain\` tools;
it logs no task text and uses the same miniature scorer as the observe hook.

## What it does

On \`SessionStart\`, supplies concise routing guidance: automatically delegate
specific, well-scoped coding tasks at cheap effort when the host supports it;
keep error output and escalate one tier at a time to mid then frontier when work fails or
verification is weak. Reserve frontier for cross-cutting, unclear-cause, or
orchestration work. A tier is never permission; irreversible or uncertain work
goes to a human, and the main session model is never swapped.

On \`UserPromptSubmit\`, runs \`scripts/jev-observe.mjs\`:

1. Scores the prompt with simple signals (payments / auth / migration /
   delete / production, ambiguity, length) → tier \`cheap\` | \`mid\` |
   \`frontier\`.
2. Appends one JSON line to the observe log (tier, signals, prompt length —
   never the full prompt text).
3. Prints advisory routing context; the host performs any delegation.

The hook launcher checks for Node and exits silently with status 0 when Node is
unavailable, so plugin loading remains fail-open. The CLI is not needed for
normal use.

## Claude Code (secondary host)

Install using \`/plugin marketplace add HaraldSigvartsen/jev\`, then
\`/plugin install jev@jev\`. The agents below are Claude-only; Codex custom
agents are TOML in ~/.codex/agents and are not bundled by this plugin.

### Subagent models

| Tier | Agent | Claude Code model alias |
| --- | --- | --- |
| cheap | jev-cheap | ${models.cheap} |
| mid | jev-mid | ${models.mid} |
| frontier | jev-frontier | ${models.frontier} |

Set \`subagentModels\` in the JSON passed to \`--config\` (or in
\`JevPluginConfig\` passed to \`buildPluginFiles\` / \`writePluginFiles\`).
Allowed aliases: \`haiku\`, \`sonnet\`, \`opus\`, \`inherit\`; omitted tiers default
to haiku / sonnet / inherit. \`inherit\` uses the main session's model for the
subagent; it does not guarantee a frontier-class model or a lower cost.
Aliases are baked into agent frontmatter at generation time; regenerate after
config changes. Editing the emitted \`config.json\` does not change agent models.

## What it does NOT do

- Does **not** block prompts or tool use.
- Does **not** swap the host model mid-session (a plugin cannot do that —
  see the main jev README honesty section).
- Does **not** call remote APIs or send prompt text anywhere.

## Log location and privacy

- Default: \`~/.jev/${logFileName}\` (configured basename; path segments and
  weird names are sanitized to \`${DEFAULT_LOG_FILE}\`).
- Override (wins): set env \`JEV_OBSERVE_LOG\` to any file path — the env
  value always takes priority over the configured basename.
- Each line is \`{ts, session_id, cwd, tier, signals, promptChars}\` —
  **no prompt text** is written.

## Uninstall

Remove the plugin directory from your Claude Code plugins location (or stop
passing \`--plugin-dir\`), and delete \`~/.jev\` if you no longer want local
observe logs.
`;
}

/** Build the relative path → file content map for the observe-only plugin. */
export function buildPluginFiles(
  config: JevPluginConfig = {},
): Record<string, string> {
  config = parseJevPluginConfig(config);
  const protectedPaths = config.protectedPaths ?? [];
  const logFileName = sanitizeLogFileName(config.logFileName);
  const subagentModels = { ...DEFAULT_SUBAGENT_MODELS, ...config.subagentModels };

  const pluginJson = {
    name: 'jev',
    version: PLUGIN_VERSION,
    description:
      'Jev observe-only decision log and advisory subagent routing. Never blocks or changes the main session model.',
    author: { name: 'Harald Sigvartsen' },
  };

  const codexPluginJson = {
    name: 'jev',
    version: PLUGIN_VERSION,
    description: 'Codex-first automatic advisory routing, lifecycle guidance, and voluntary MCP route/explain tools. Never blocks or swaps the main model.',
    author: { name: 'Harald Sigvartsen' },
    homepage: 'https://github.com/HaraldSigvartsen/jev',
    repository: 'https://github.com/HaraldSigvartsen/jev',
    license: 'MIT',
    skills: './skills/',
    hooks: './hooks/hooks.json',
    mcpServers: './.mcp.json',
    interface: {
      displayName: 'Jev',
      shortDescription: 'Cheap-first advisory routing for Codex.',
      longDescription: 'Automatic lifecycle guidance and a routing skill, with voluntary local MCP route/explain tools. Escalate uncertainty; humans approve irreversible actions. Claude Code supported as second host.',
      developerName: 'Harald Sigvartsen',
      category: 'Developer Tools',
      capabilities: ['Instructions', 'Lifecycle hooks'],
      defaultPrompt: ['Size this coding task with Jev.', 'Explain the recommended effort tier.', 'Start cheap and escalate when verification is weak.'],
    },
  };

  const hooksJson = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/jev-hook.sh"',
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
              command: 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/jev-hook.sh"',
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

  return {
    '.codex-plugin/plugin.json': `${JSON.stringify(codexPluginJson, null, 2)}\n`,
    '.mcp.json': `${JSON.stringify({ mcpServers: { jev: { command: 'node', args: ['./scripts/jev-mcp.mjs'], cwd: '.' } } }, null, 2)}\n`,
    'scripts/jev-mcp.mjs': mcpScript(),
    '.claude-plugin/plugin.json': `${JSON.stringify(pluginJson, null, 2)}\n`,
    'hooks/hooks.json': `${JSON.stringify(hooksJson, null, 2)}\n`,
    'scripts/jev-hook.sh': '#!/bin/sh\nif ! command -v node >/dev/null 2>&1; then\n  exit 0\nfi\nDIR=$(dirname "$0")\nexec node "$DIR/jev-observe.mjs"\n',
    'scripts/jev-observe.mjs': script.endsWith('\n') ? script : `${script}\n`,
    'skills/jev-routing/SKILL.md': `---
name: jev-routing
description: Applies automatically when delegating or choosing effort for coding tasks.
---

# Jev routing

Jev provides advisory routing for Codex first, with Claude Code also supported.
Call the \`jev_route\` or \`jev_explain\` MCP tool when available to size a task.
Start specific, well-scoped coding work at cheap effort; delegate automatically
when the host supports it and its instructions allow delegation.

If a tier fails or verification is weak, preserve the error output and escalate
one tier at a time: cheap → mid → frontier. Abstention and uncertainty escalate
up. Reserve frontier for cross-cutting work, unclear causes, or orchestration.
Claude Code can use \`jev:jev-cheap\`, \`jev:jev-mid\`, and
\`jev:jev-frontier\`. The bundled agents/*.md are Claude-only; Codex custom
agents live in ~/.codex/agents as TOML and are not bundled here.

A tier is never permission. Irreversible or uncertain actions go to a human;
the judge never solely approves irreversible actions. Enforcement belongs in
CI/merge outside this session. The main session model is never swapped.
`,
    'config.json': `${JSON.stringify(configJson, null, 2)}\n`,
    'README.md': pluginReadme(logFileName, subagentModels),
    ...Object.fromEntries(
      (Object.keys(subagentModels) as RouteTier[]).map((tier) => [
        `agents/jev-${tier}.md`,
        `---
name: jev-${tier}
description: Handles delegated ${tier}-tier tasks when Jev suggests jev-${tier}. Advisory only; the host decides whether to delegate.
model: ${subagentModels[tier]}
---

You are Jev's ${tier}-tier subagent. Work only on the task delegated by the host.
Jev routing is advisory; a tier is not permission to perform an action.
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
export function writePluginFiles(outDir: string, config: JevPluginConfig = {}): string[] {
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
