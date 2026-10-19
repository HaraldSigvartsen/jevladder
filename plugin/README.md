# Jev — Codex-first advisory plugin

Version 0.5.0. Jev is active automatically with sensible defaults;
no CLI commands are needed after installation and hook trust review.
SessionStart provides automatic delegation guidance, and UserPromptSubmit adds an advisory route tier.
Never blocks or changes the main session model.

## Install

Install from the Jev marketplace in Codex:

```bash
codex plugin marketplace add HaraldSigvartsen/jev
codex plugin add jev@jev
```

Then just use Codex normally. Codex asks you to review/trust the plugin's hooks
once (`/hooks`); this is Codex's safety prompt, not config editing. The bundled
MCP server needs Node and exposes voluntary `jev_decide`, `jev_route` /
`jev_explain` tools; it logs no task or diff text. `jev_decide` is an
advisory miniature pre-merge check; enforcement stays in CI/merge.

## What it does

On `SessionStart`, supplies concise routing guidance: automatically delegate
specific, well-scoped coding tasks at cheap effort when the host supports it;
keep error output and escalate one tier at a time to mid then frontier when work fails or
verification is weak. Reserve frontier for cross-cutting, unclear-cause, or
orchestration work. A tier is never permission; irreversible or uncertain work
goes to a human, and the main session model is never swapped.

On `UserPromptSubmit`, runs `scripts/jev-observe.mjs`:

1. Scores the prompt with simple signals (payments / auth / migration /
   delete / production, ambiguity, length) → tier `cheap` | `mid` |
   `frontier`.
2. Appends one JSON line to the observe log (tier, signals, prompt length —
   never the full prompt text).
3. Prints advisory routing context; the host performs any delegation.

The hook launcher checks for Node and exits silently with status 0 when Node is
unavailable, so plugin loading remains fail-open. The CLI is not needed for
normal use.

## Claude Code (secondary host)

Install using `/plugin marketplace add HaraldSigvartsen/jev`, then
`/plugin install jev@jev`. The agents below are Claude-only; Codex custom
agents are TOML in ~/.codex/agents and are not bundled by this plugin.

### Subagent models

| Tier | Agent | Claude Code model alias |
| --- | --- | --- |
| cheap | jev-cheap | haiku |
| mid | jev-mid | sonnet |
| frontier | jev-frontier | inherit |

Set `subagentModels` in the JSON passed to `--config` (or in
`JevPluginConfig` passed to `buildPluginFiles` / `writePluginFiles`).
Allowed aliases: `haiku`, `sonnet`, `opus`, `inherit`; omitted tiers default
to haiku / sonnet / inherit. `inherit` uses the main session's model for the
subagent; it does not guarantee a frontier-class model or a lower cost.
Aliases are baked into agent frontmatter at generation time; regenerate after
config changes. Editing the emitted `config.json` does not change agent models.

## What it does NOT do

- Does **not** block prompts or tool use.
- Does **not** swap the host model mid-session (a plugin cannot do that —
  see the main jev README honesty section).
- Does **not** call remote APIs or send prompt text anywhere.

## Log location and privacy

- Default: `~/.jev/observe.jsonl` (configured basename; path segments and
  weird names are sanitized to `observe.jsonl`).
- Override (wins): set env `JEV_OBSERVE_LOG` to any file path — the env
  value always takes priority over the configured basename.
- Each line is `{ts, session_id, cwd, tier, signals, promptChars}` —
  **no prompt text** is written.

## Uninstall

Remove the plugin directory from your Claude Code plugins location (or stop
passing `--plugin-dir`), and delete `~/.jev` if you no longer want local
observe logs.
