# TierClef plugin and MCP security

## Threat model

TierClef hooks run as part of the host application with the same operating
system privileges as the user running that application. They can read their
standard input and write the local observe log. Installing a plugin does not
put it in a separate security sandbox. Only install and configure code you
trust, and review updates as you would other software running as your user.

The generated observe hook reads host event JSON, computes a small routing
annotation, and optionally writes a privacy-limited log. It does not read
project files, run commands, change the host model, block a host action, or
send data over the network. The bundled MCP server reads JSON-RPC requests on
stdin and responds on stdout. Its route/explain tools are advisory; its
miniature decide tool is also advisory and does not replace CI or merge
enforcement. MCP does not make network requests or log task/diff inputs.

The optional judge client in the TierClef library is library-only: the plugin
and MCP server do not invoke it. If an application using the library
explicitly configures the client, it makes a request to that configured
endpoint with a 15-second timeout. Missing, malformed, or unavailable judge
responses abstain so the gate can defer to a human; they do not produce an
allow decision.

Hooks fail open: malformed or oversized hook input, log failures, and other
hook errors exit successfully without printing prompt/task content. This keeps
the host usable if an advisory hook fails. The gate and CI have a different
responsibility: callers should enforce their configured rules there, where
uncertain or invalid decisions can fail closed or require human review. Do not
treat observe hooks or MCP tools as enforcement boundaries.

## Data and privacy

The observe log contains only `ts`, `session_id`, `cwd`, `tier`, `signals`, and
`promptChars`. Prompt, task, and diff text are never written to that log or
echoed in hook/MCP error messages. Rule findings use rule IDs rather than
including matched secret values. Hook stdout contains only the routing
annotation (or fixed SessionStart guidance); malformed and oversized input is
silent.

Set `TIERCLEF_NO_LOG=1` (or `TIERCLEF_NO_LOG=true`) to disable observe-log
writing while keeping the UserPromptSubmit annotation. By default the log is
`~/.tierclef/observe.jsonl`; `TIERCLEF_OBSERVE_LOG` overrides the path. Before
an append, a log at least 1 MB in size is rotated once to
`<log-path>.1` (replacing the previous rotated file), then a fresh log is
started. Rotation or write errors are ignored by the fail-open hook.

## Configuration and shipped files

Plugin configuration is a TypeScript file you own and execute in your own
project or host setup. Treat it as code: inspect it before running it, and do
not load an untrusted config. The generated `config.json` contains values
copied from that configuration; the plugin does not discover or execute
arbitrary project configuration automatically.

The checked-in generated plugin inventory is:

- `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json` — host metadata.
- `.mcp.json` — local stdio MCP launch configuration.
- `agents/` — routing guidance for supported host agents.
- `hooks/` — hook event registration.
- `hooks/hooks.json` — hook event registration.
- `scripts/tierclef-hook.sh` — silent Node launcher.
- `scripts/tierclef-observe.mjs` — standalone observe hook.
- `scripts/tierclef-mcp.mjs` — standalone advisory MCP server.
- `skills/` — routing usage guidance.
- `config.json` — generated plugin settings.
- `README.md` — plugin setup and usage.

These files have zero runtime package dependencies and no `postinstall` or
other install-time script. Node.js is required to run the hook and MCP server.

## Disable or uninstall

- **Codex:** remove the TierClef plugin from the enabled plugins in Codex
  settings, or stop supplying its plugin directory to the host.
- **Claude Code:** remove TierClef from the enabled plugin list, or uninstall it
  with the Claude Code plugin manager used for installation.
- **Manual/local install:** remove the generated plugin directory and remove
  its `.mcp.json` server entry from the host project configuration.
- **Stop logging only:** set `TIERCLEF_NO_LOG=1`. To remove existing local logs,
  delete `~/.tierclef/observe.jsonl` and its optional `.1` rotated file.

Disabling a plugin does not delete logs already written to disk.
