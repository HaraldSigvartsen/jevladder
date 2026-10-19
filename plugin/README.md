# jev Claude Code plugin (observe-only)

Version 0.2.0. Annotates prompts with a miniature route tier.
Never blocks. Never changes models.

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
```

## What it does

On `UserPromptSubmit`, runs `scripts/jev-observe.mjs`:

1. Scores the prompt with simple signals (payments / auth / migration /
   delete / production, ambiguity, length) → tier `cheap` | `mid` |
   `frontier`.
2. Appends one JSON line to the observe log (tier, signals, prompt length —
   never the full prompt text).
3. Prints `additionalContext` so the session can see the annotation.

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
