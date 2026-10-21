# JevLadder plugin and MCP security

## Threat model

JevLadder hooks run as part of the host application with the same operating
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

The merge gate has one placeholder exception, granted only when BOTH conditions hold. First, the file's basename is an env template name: `.env`, `.env.<anything>`, or `<prefix>.env` followed by an explicit `example`, `sample`, `template`, or `dist` suffix — multi-component node-env spellings are recognized, so `.env.example`, `.env.production.local.example`, `.env.development.sample`, and `foo.env.template` all qualify, while real env files (`.env`, `.env.local`, `.env.production`) never do. A directory with a template name never exempts its children. Second, the ENTIRE added line is one strict dotenv assignment: an optional `export` prefix, KEY `[A-Za-z_][A-Za-z0-9_]*`, `=`, and a VALUE that is exactly one of: empty; `""`; `''`; an angle placeholder of lowercase letters, underscores, hyphens, and spaces (`<insert value here>`); the same angle placeholder double-quoted (`"<insert value here>"`); `changeme` (or `CHANGEME`); a `your_..._here` placeholder in any case; or a repeated-`x` mask (`xxx`, `xxxx`, …). NOTHING else may appear on the line — no trailing comment, no trailing text, no second assignment, no concatenation, no `${VAR}`, no `replace-me`/`example`/`dummy`/`placeholder` spellings, no non-empty single-quoted value. Any other line in a template file, and every line of every other file, goes through the ordinary secret matchers with no exemption. File context is derived ONLY from `diff --git a/… b/…` header lines and is fully reset at every such header: `+++`/`---` lines never change file context, so header-shaped added content (for example a source line containing `++ b/.env.example`, which renders as `+++ b/.env.example`) cannot switch the scanner into template context, and a file following a template in a multi-file diff never inherits the exemption. A `diff --git` header whose paths cannot be parsed unambiguously (quoted paths, paths containing spaces), or a diff with no `diff --git` headers at all, is treated as an ordinary source file: no exemptions, full scanning. Two matchers always take precedence over this exemption and run over the complete line first: private-key block headers and known credential token prefixes (`sk-`, `ghp_`, `xoxb-`, `glpat-`, AWS `AKIA…`). A recognized token inside `API_KEY="<...>"` or after a trailing `# comment` therefore still blocks. This exemption is deliberately narrow, and heuristic detection cannot identify every possible credential format, so do not commit real credentials. A separate exemption covers a full-line `#` comment in that same template context when every key-like assignment on the line is lowercase prose (a word of eight or more letters, then more words). It does not cover trailing comments on assignment lines, credential-shaped values, known token prefixes, or private-key headers.

The merge gate also scans changed added and removed lines for code-shaped auth, session, and security operations. It blocks patterns such as session/token expiry or lifetime settings, JWT signing or verification, password hash/compare operations, permission/role checks, and auth/CSRF middleware even when the path is neutral. Middleware detection reads the full `app/router/server . use(...)` argument list with comment- and string-aware parenthesis balancing: `//` and block-comment contents are ignored (a `)` inside a comment cannot terminate the argument list), quoted-string text is never read as identifiers, and template-literal text (for example `` `/session` ``) is treated as a string — while `${...}` interpolation expressions are still inspected using the same string/comment-aware lexing (interpolation strings and comments are stripped, nested templates recurse), so `` app.use(`/x/${authMiddleware}`) `` blocks but `` app.use(`${base}/${section ?? "session"}`, publicRouter) `` and `` app.use(`${base /* session routes */}`, publicRouter) `` do not. Regex literal contents (for example `/session/` in `` app.use(/session/, publicRouter) ``) are likewise excluded from identifier scanning and parenthesis balancing, and the raw call-shaped auth/CSRF/session checks run over the line with regex-literal contents stripped too, so regex pattern source such as `/auth(?:ors)?/` or `/session(.*)/` in a middleware route never reads as an `auth(` or `session(` call while real calls (including `` app.use(session({ ... })) ``) still block. Known limitation: a regex literal nested inside a `${...}` interpolation (for example `` app.use(`${prefix.replace(/session/g, "talk")}`, publicRouter) ``) is not yet regex-stripped and may ask for human review; this errs toward blocking, never toward allowing. Auth identifiers are constrained to auth/authn/authz/authentication/authorization/session/CSRF families, so author/content identifiers such as `authorsRouter` do not match. Standalone `sign(`/`verify(` calls with jwt/token arguments block, as do member calls on any receiver except the exact `Math` receiver: `Math.sign`, `Math . sign`, and `Math. sign` stay exempt, while `crypto.verify(token)`, `session.verify(token)`, and `jwt.sign(token, …)` block. This content detection is heuristic and block-only: a match asks for human review and never allows a change. Markdown files are excluded for changed lines using the file path from the `diff --git` header of the file they belong to (old path for removed lines, new path for added lines), and that exclusion resets at every header — a source file following a Markdown file in the same diff is scanned normally. Detection happens line by line: logic split across multiple physical diff lines (for example a middleware call continued onto the next line) is not reassembled. The rule may also miss sensitive semantics without recognizable code-shaped signals, including unfamiliar implementations or dynamically constructed operations; code that closely resembles these patterns may also require human review.

The optional judge client in the JevLadder library is library-only: the plugin
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

## Known weaknesses and residual risk

Three previously labelled policy gaps are closed. Their `knownWeakness`
markers are removed, and they count in headline accuracy:

- A `Binary files a/… and b/… differ` notice on a path that is not already
  blocked by `protected-paths` returns `human` from `uninspectable-binary`.
  The gate does not ask the judge to allow bytes it cannot read. A protected
  path still blocks first.
- `scoreRoute` rejects empty or whitespace-only input (`rejected: true`). The
  CLI exits 1. It does not assign a tier.
- A full-line `#` comment in an env template (file context from `diff --git`)
  whose assignment value is a lowercase prose word followed by more words is
  not a `secrets-in-diff` hit. Known credential prefixes and private-key
  headers on that line still block. The same comment in a non-template file
  still blocks. Assignment lines with a trailing comment are unchanged.

Generated reports still list any task marked `knownWeakness`. A case that
passes should have that marker removed after the rule change is intentional.
Other independent-eval disagreements stay labelled `predictedRisk` and are
not tuned away.

The observe log contains only `ts`, `session_id`, `cwd`, `tier`, `signals`, and
`promptChars`. Prompt, task, and diff text are never written to that log or
echoed in hook/MCP error messages. Rule findings use rule IDs rather than
including matched secret values. Hook stdout contains only the routing
annotation (or fixed SessionStart guidance); malformed and oversized input is
silent.

Set `JEVLADDER_NO_LOG=1` (or `JEVLADDER_NO_LOG=true`) to disable observe-log
writing while keeping the UserPromptSubmit annotation. By default the log is
`~/.jevladder/observe.jsonl`; `JEVLADDER_OBSERVE_LOG` overrides the path. Before
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
- `scripts/jevladder-hook.sh` — silent Node launcher.
- `scripts/jevladder-observe.mjs` — standalone observe hook.
- `scripts/jevladder-mcp.mjs` — standalone advisory MCP server.
- `skills/` — routing usage guidance.
- `config.json` — generated plugin settings.
- `README.md` — plugin setup and usage.

These files have zero runtime package dependencies and no `postinstall` or
other install-time script. Node.js is required to run the hook and MCP server.

## Disable or uninstall

- **Codex:** remove the JevLadder plugin from the enabled plugins in Codex
  settings, or stop supplying its plugin directory to the host.
- **Claude Code:** remove JevLadder from the enabled plugin list, or uninstall it
  with the Claude Code plugin manager used for installation.
- **Manual/local install:** remove the generated plugin directory and remove
  its `.mcp.json` server entry from the host project configuration.
- **Stop logging only:** set `JEVLADDER_NO_LOG=1`. To remove existing local logs,
  delete `~/.jevladder/observe.jsonl` and its optional `.1` rotated file.

Disabling a plugin does not delete logs already written to disk.
