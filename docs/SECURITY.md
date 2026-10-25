# JevLadder plugin and MCP security

## Threat model

JevLadder hooks run as part of the host application with the same operating
system privileges as the user running that application. They can read their
standard input and write the local observe log. Installing a plugin does not
put it in a separate security sandbox. Only install and configure code you
trust, and review updates as you would other software running as your user.

The published npm tarball is constrained by `package.json` `files` (including
excluded source maps) and by `test/package-contents.test.ts` in CI. That test
re-runs `npm pack --dry-run`, requires an allowlisted path set, and fails if
tests, eval fixtures, env files, internal notes, `.map` files, local home
paths, or secret-shaped strings would ship.

Contributors and CI install dev dependencies with pnpm from a frozen
`pnpm-lock.yaml`. pnpm does not run dependency lifecycle scripts unless they
are explicitly allowed, and `pnpm-workspace.yaml` explicitly denies the one dev
dependency that would ask (esbuild, pulled in by vitest; its prebuilt platform
package works without the postinstall). jevladder itself has no runtime
dependencies and no install scripts.

The generated observe hook reads host event JSON, computes a small routing
annotation, and optionally writes a privacy-limited log. It does not read
project files, run commands, change the host model, block a host action, or
send data over the network. The bundled MCP server reads JSON-RPC requests on
stdin and responds on stdout. Its route/explain tools are advisory; its
miniature decide tool is also advisory and does not replace CI or merge
enforcement. MCP does not log task or diff inputs. The decide tool may call
TypeSafe System One when a judge API key is configured (see below); route and
explain never call the network.

The merge gate has one placeholder exception, granted only when BOTH conditions hold. First, the file's basename is an env template name: `.env`, `.env.<anything>`, or `<prefix>.env` followed by an explicit `example`, `sample`, `template`, or `dist` suffix — multi-component node-env spellings are recognized, so `.env.example`, `.env.production.local.example`, `.env.development.sample`, and `foo.env.template` all qualify, while real env files (`.env`, `.env.local`, `.env.production`) never do. A directory with a template name never exempts its children. Second, the ENTIRE added line is one strict dotenv assignment: an optional `export` prefix, KEY `[A-Za-z_][A-Za-z0-9_]*`, `=`, and a VALUE that is exactly one of: empty; `""`; `''`; an angle placeholder of lowercase letters, underscores, hyphens, and spaces (`<insert value here>`); the same angle placeholder double-quoted (`"<insert value here>"`); `changeme` (or `CHANGEME`); a `your_..._here` placeholder in any case; or a repeated-`x` mask (`xxx`, `xxxx`, …). NOTHING else may appear on the line — no trailing comment, no trailing text, no second assignment, no concatenation, no `${VAR}`, no `replace-me`/`example`/`dummy`/`placeholder` spellings, no non-empty single-quoted value. Any other line in a template file, and every line of every other file, goes through the ordinary secret matchers with no exemption. File context is derived ONLY from `diff --git a/… b/…` header lines and is fully reset at every such header: `+++`/`---` lines never change file context, so header-shaped added content (for example a source line containing `++ b/.env.example`, which renders as `+++ b/.env.example`) cannot switch the scanner into template context, and a file following a template in a multi-file diff never inherits the exemption. A `diff --git` header whose paths cannot be parsed unambiguously (quoted paths, paths containing spaces), or a diff with no `diff --git` headers at all, is treated as an ordinary source file: no exemptions, full scanning. Two matchers always take precedence over this exemption and run over the complete line first: private-key block headers and known credential token prefixes (`sk-`, `ghp_`, `xoxb-`, `glpat-`, AWS `AKIA…`). A recognized token inside `API_KEY="<...>"` or after a trailing `# comment` therefore still blocks. This exemption is deliberately narrow, and heuristic detection cannot identify every possible credential format, so do not commit real credentials. A separate exemption covers a full-line `#` comment in that same template context when every key-like assignment on the line is lowercase prose (a word of eight or more letters, then more words). It does not cover trailing comments on assignment lines, credential-shaped values, known token prefixes, or private-key headers.

The merge gate also scans changed added and removed lines for code-shaped auth, session, and security operations. It blocks patterns such as session/token expiry or lifetime settings, JWT signing or verification, password hash/compare operations, permission/role checks, and auth/CSRF middleware even when the path is neutral. Middleware detection reads the full `app/router/server . use(...)` argument list with comment- and string-aware parenthesis balancing: `//` and block-comment contents are ignored (a `)` inside a comment cannot terminate the argument list), quoted-string text is never read as identifiers, and template-literal text (for example `` `/session` ``) is treated as a string — while `${...}` interpolation expressions are still inspected using the same string/comment-aware lexing (the closing `}` is found with that same awareness, so a `{` or `}` inside a string, comment, regex literal, or nested template does not end or extend the interpolation; interpolation strings and comments are stripped, nested templates recurse), so `` app.use(`/x/${authMiddleware}`) `` blocks but `` app.use(`${base}/${section ?? "session"}`, publicRouter) `` and `` app.use(`${base /* session routes */}`, publicRouter) `` do not. Regex literal contents (for example `/session/` in `` app.use(/session/, publicRouter) ``) are likewise excluded from identifier scanning and parenthesis balancing, including regex literals nested inside `${...}` interpolation expressions (for example `` app.use(`${prefix.replace(/session/g, "talk")}`, publicRouter) ``), and the raw call-shaped auth/CSRF/session checks run over the line with regex-literal contents stripped in top-level code and inside those interpolations too, so regex pattern source such as `/auth(?:ors)?/` or `/session(.*)/` never reads as an `auth(` or `session(` call while real calls and identifiers (including `` app.use(`/x/${authMiddleware}`) ``, `` app.use(`${base}`, session({ ... })) ``, and `` ${requireAuth()} `` inside a route template) still block; division inside an interpolation is not treated as a regex start, so an auth identifier after `/` still blocks. Unterminated regex inside an interpolation is left as raw text and may still ask for human review. Auth identifiers are constrained to auth/authn/authz/authentication/authorization/session/CSRF families, so author/content identifiers such as `authorsRouter` do not match. Standalone `sign(`/`verify(` calls with jwt/token arguments block, as do member calls on any receiver except the exact `Math` receiver: `Math.sign`, `Math . sign`, and `Math. sign` stay exempt, while `crypto.verify(token)`, `session.verify(token)`, and `jwt.sign(token, …)` block. This content detection is heuristic and block-only: a match asks for human review and never allows a change. Markdown files are excluded for changed lines using the file path from the `diff --git` header of the file they belong to (old path for removed lines, new path for added lines), and that exclusion resets at every header — a source file following a Markdown file in the same diff is scanned normally. Detection happens line by line: logic split across multiple physical diff lines (for example a middleware call continued onto the next line) is not reassembled. The rule may also miss sensitive semantics without recognizable code-shaped signals, including unfamiliar implementations or dynamically constructed operations; code that closely resembles these patterns may also require human review. Identifier checks additionally block session/token lifetime names in any common casing, including plural forms (`sessionsTtl`, `SESSIONS_TTL_SECONDS`, `tokensExpiry`), and declarations (`function`/`class`/`interface`/`type`/`enum`/`const`/`let`/`var`) whose names carry auth/session/CSRF words — including a field edit inside such a declaration when its header is only hunk context — plus member declarations with no keyword in front: a method shorthand (optionally after `public`/`private`/`protected`/`static`/`readonly`/`override`/`abstract`/`declare`/`async`/`get`/`set`/`*` modifiers) whose argument list closes on the line and is followed by an optional return type and a body `{`, or a `name:` / `name =` property member (`validateSession(token) {`, `get sessionTtl() {`, `isAuthed = () => !!this.user`); call sites are not declarations (`foo.validateSession(x)` does not start with the member name, a bare call has no body `{` after its closing parenthesis, `==`/`=>` are comparison/arrow-parameter shapes, and `if (`/`for (`/`while (`/`switch (`/`catch (`/`return` never name members), and a member signature whose parentheses or body brace do not close on the changed line is not reassembled; label words (`sessionName`, `sessionStorage`) and bare analytics plurals (`const sessions = useAnalytics()`, `const tokens = design(theme)`) stay allowed, and `author`/`authority`/`oauth`/`tokenizer` never count as auth/session/token words. Changed lines that are full-line comments are skipped: `//` lines; `#` lines only when the `#` is followed by a space, tab, `!`, or end of line (a JS/TS private field like `#sessionTtl = 3600` is code and is scanned); one-line block comments; a bare closing star-slash; and `*`-plus-space JSDoc continuations. No block-comment state is carried across lines: a continuation line of a multi-line block comment that is not itself star-shaped is scanned as code and may still block (safe direction).

### TypeSafe judge (CLI, library, MCP decide)

When `JEVLADDER_TYPESAFE_API_KEY` or `TYPESAFE_API_KEY` is set, the CLI
`check` command, the default library wiring (`createDefaultJudge`), and the
bundled MCP `jevladder_decide` tool may call:

`https://api.typesafe.ai/v1/systemone` (fixed host; not configurable)

Request headers include `Authorization: Bearer <key>`, JSON content types, and
`User-Agent: jevladder/<version>`. The JSON body sends model `jev-1.13.0`, a
minimal `state` summary (changed file paths, added/removed line counts, a
truncated excerpt of changed lines capped around 2000 characters, and an
`irreversible` flag), and a single `choice` question (`approve` / `escalate`).
Full files, environment variables, and API keys are never sent. Responses are
not echoed in error messages.

Timeout is about eight seconds. Missing key, HTTP errors, timeouts, malformed
responses, unknown choices, low confidence (below 0.6), or `escalate` all
fail closed to a human decision — never an implicit allow. Deterministic merge
rules (secrets, protected paths, tests-not-green, TODO markers, irreversible
flags in MCP decide, and similar) run before the model and cannot be overridden
by an approve.

The optional `OpenAICompatibleJudge` in the library is separate: it only runs
when an application wires it explicitly, uses a caller-configured base URL,
reads `JEVLADDER_JUDGE_API_KEY` by default (never TypeSafe credential env vars),
and defaults to a 15-second timeout. API keys are not shared across providers.

Hooks fail open: malformed or oversized hook input, log failures, and other
hook errors exit successfully without printing prompt/task content. This keeps
the host usable if an advisory hook fails. The gate and CI have a different
responsibility: callers should enforce their configured rules there, where
uncertain or invalid decisions can fail closed or require human review. Do not
treat observe hooks or MCP tools as enforcement boundaries.

The Cursor host adapter ships project `.cursor/mcp.json` (local stdio MCP),
`.cursor/jevladder/jevladder-mcp.mjs` (dependency-free bundled server), and
`.cursor/rules/jevladder.mdc` (always-on advisory routing guidance). It does
not install Cursor lifecycle hooks: the shared observe script targets Codex and
Claude hook payloads, and Cursor command hooks can set `permission` outcomes when
configured to do so. JevLadder does not ship Cursor hooks until a fail-open,
context-only mapping is verified. The bundled MCP `jevladder_decide` tool remains
fail closed without a judge API key; route and explain stay offline.

The ZCode host adapter is advisory only. `jevladder plugin --host zcode --out <dir>`
writes `mcp-servers.json`, `AGENTS.jevladder.md`, and a bundled stdio MCP under
`<dir>/zcode/` only. It never reads or writes `~/.zcode` or other home-directory
config; you merge the fragment into `~/.zcode/cli/config.json` and append guidance
to `~/.zcode/AGENTS.md` yourself. No ZCode lifecycle hooks are shipped; enforcement
stays in CI/merge (`jevladder check`).

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
`promptChars`. Prompt, task, diff text, and PreToolUse tool input are never
written to that log or echoed in hook/MCP error messages. Rule findings use
rule IDs rather than including matched secret values. Hook stdout contains only
the routing annotation, fixed SessionStart guidance, or advisory PreToolUse
context with no command text and no file contents. PreToolUse never sets
`permissionDecision`. Malformed and oversized input is silent.

`jevladder check` also appends a separate decision log. Each line is only
`ts`, `outcome`, `source`, and an optional `ruleId`. Diff text, paths, and
reasons are not written. The default path is `~/.jevladder/decisions.jsonl`;
`JEVLADDER_DECISION_LOG` overrides it. `jevladder propose` reads that log and
prints a suggestion. It does not edit gate config. `--open` creates a pull
request and leaves it open; the command has no merge step, and `--merge` is
rejected. Without a suggestion, no pull request is opened.

Set `JEVLADDER_NO_LOG=1` (or `JEVLADDER_NO_LOG=true`) to disable observe-log
and decision-log writing while keeping the UserPromptSubmit annotation. By default the observe log is
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
- `opencode/jevladder.mjs` — OpenCode adapter. It does not rewrite tool arguments, deny permission, or log prompt or tool text.
- `cursor/.cursor/mcp.json`, `cursor/.cursor/jevladder/jevladder-mcp.mjs`, and `cursor/.cursor/rules/jevladder.mdc` — Cursor project config templates (copy or `jevladder plugin --host cursor --out .`). No secrets in JSON; MCP inherits judge keys from the environment.
- `zcode/mcp-servers.json`, `zcode/AGENTS.jevladder.md`, and `zcode/jevladder/jevladder-mcp.mjs` — ZCode global-config fragments (`jevladder plugin --host zcode --out <dir>`). Template uses a relative MCP path; the CLI emits an absolute path for merging into `~/.zcode/cli/config.json`. Never writes home config.
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
