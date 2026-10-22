# JevLadder — Codex-first advisory plugin

Version 0.6.0. JevLadder is active automatically with sensible defaults;
no CLI commands are needed after installation and hook trust review.
SessionStart provides automatic delegation guidance, and UserPromptSubmit adds an advisory route tier.
PreToolUse adds advisory context before file writes and merge-like shell commands.
It never approves or denies the tool call. Never blocks or changes the main session model.

## Install

Install from the JevLadder marketplace in Codex:

```bash
codex plugin marketplace add HaraldSigvartsen/jevladder
codex plugin add jevladder@jevladder
```

Then just use Codex normally. Codex asks you to review/trust the plugin's hooks
once (`/hooks`); this is Codex's safety prompt, not config editing. The bundled
MCP server needs Node and exposes voluntary `jevladder_decide`, `jevladder_route` /
`jevladder_explain` tools; it logs no task or diff text. `jevladder_decide` is an
advisory miniature pre-merge check; enforcement stays in CI/merge.

## What it does

On `SessionStart`, supplies concise routing guidance: automatically delegate
specific, well-scoped coding tasks at cheap effort when the host supports it;
keep error output and escalate one tier at a time to mid then frontier when work fails or
verification is weak. Reserve frontier for cross-cutting, unclear-cause, or
orchestration work. A tier is never permission; irreversible or uncertain work
goes to a human, and the main session model is never swapped.

On `UserPromptSubmit`, runs `scripts/jevladder-observe.mjs`:

1. Scores the prompt with simple signals (payments / auth / migration /
   delete / production, ambiguity, length) → tier `cheap` | `mid` |
   `frontier`.
2. Appends one JSON line to the observe log (tier, signals, prompt length —
   never the full prompt text).
3. Prints advisory routing context; the host performs any delegation.

On `PreToolUse` for `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `apply_patch`, and
`Bash`, the same script prints advisory context for file writes and for
merge-like commands (`git merge`, `git push`, `git rebase`, `gh pr merge`).
Other shell commands produce no output. The hook does not log tool input,
file contents, or command text, and it never sets `permissionDecision`.

The hook launcher checks for Node and exits silently with status 0 when Node is
unavailable, so plugin loading remains fail-open. The CLI is not needed for
normal use.

## Claude Code (secondary host)

Install using `/plugin marketplace add HaraldSigvartsen/jevladder`, then
`/plugin install jevladder@jevladder`. The agents below are Claude-only; Codex custom
agents are TOML in ~/.codex/agents and are not bundled by this plugin.

### Subagent models

| Tier | Agent | Claude Code model alias |
| --- | --- | --- |
| cheap | jevladder-cheap | haiku |
| mid | jevladder-mid | sonnet |
| frontier | jevladder-frontier | inherit |

Set `subagentModels` in the JSON passed to `--config` (or in
`JevLadderPluginConfig` passed to `buildPluginFiles` / `writePluginFiles`).
Allowed aliases: `haiku`, `sonnet`, `opus`, `inherit`; omitted tiers default
to haiku / sonnet / inherit. `inherit` uses the main session's model for the
subagent; it does not guarantee a frontier-class model or a lower cost.
Aliases are baked into agent frontmatter at generation time; regenerate after
config changes. Editing the emitted `config.json` does not change agent models.

## OpenCode (additional host)

`opencode/jevladder.mjs` exports `JevLadderPlugin`. Place that file at
`.opencode/plugins/jevladder.mjs` (this repository already does, via a
re-export). OpenCode then gets advisory system guidance, a route tier on user
text, and a note after file-write or merge-like shell tools. The `config` hook
adds the local `jevladder` MCP server and this plugin's `skills` directory
only when those entries are absent. Tool arguments are not rewritten, and no
permission is denied. Prompt text and tool input are not logged.

This is structural support, validated by loading the module and simulating
hooks. It is not a claim that a live OpenCode session was run.

## What it does NOT do

- Does **not** block prompts or tool use. PreToolUse and the OpenCode adapter are context only.
- Does **not** swap the host model mid-session (a plugin cannot do that —
  see the main jevladder README honesty section).
- Does **not** send prompt text anywhere. The bundled MCP `jevladder_decide` tool
  calls the TypeSafe judge API only when `JEVLADDER_TYPESAFE_API_KEY` or
  `TYPESAFE_API_KEY` is set; otherwise it defers to a human (fail closed).
  OpenAI-compatible judges use `JEVLADDER_JUDGE_API_KEY` only — keys are never
  shared across providers.

## Log location and privacy

- Default: `~/.jevladder/observe.jsonl` (configured basename; path segments and
  weird names are sanitized to `observe.jsonl`).
- Override (wins): set env `JEVLADDER_OBSERVE_LOG` to any file path — the env
  value always takes priority over the configured basename.
- Each line is `{ts, session_id, cwd, tier, signals, promptChars}` —
  **no prompt text** is written.

## Uninstall

Remove the plugin directory from your Claude Code plugins location (or stop
passing `--plugin-dir`), and delete `~/.jevladder` if you no longer want local
observe logs.
