# jev Claude Code plugin (observe-only)

Version 0.2.0. Annotates prompts with a miniature route tier.
Never blocks. Never changes the main session model. Offers advisory delegation
to the tier subagents shipped under `agents/`.

## Install

Load as a local plugin / copy into your plugins directory — see Claude Code
plugin docs. Typical options:

- Copy or symlink this directory into your Claude Code plugins location, or
- Pass `--plugin-dir` pointing at this directory if your Claude Code build
  supports loading a local plugin from a path.

Generate a fresh copy from the jev CLI:

```bash
jev plugin --out ./my-jev-plugin
# optional: jev plugin --out ./my-jev-plugin --protected '**/payments/**'
# optional: jev plugin --out ./my-jev-plugin --config ./jev-plugin.json
```

## What it does

On `UserPromptSubmit`, runs `scripts/jev-observe.mjs`:

1. Scores the prompt with simple signals (payments / auth / migration /
   delete / production, ambiguity, length) → tier `cheap` | `mid` |
   `frontier`.
2. Appends one JSON line to the observe log (tier, signals, prompt length —
   never the full prompt text).
3. Prints `additionalContext` suggesting `jev:jev-cheap`, `jev:jev-mid`, or
   `jev:jev-frontier` (plugin-scoped names) for the routed tier. The host decides whether to delegate;
   the hook never invokes an agent.

## Subagent models

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
