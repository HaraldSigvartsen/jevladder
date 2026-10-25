# Changelog

## Unreleased

- Merge gate: `sensitive-content` also blocks auth/session/CSRF-named member declarations — class/object method shorthand (with `public`/`private`/`protected`/`static`/`readonly`/`override`/`async`/`get`/`set`/`*` modifiers) and `name:`/`name =` property members — using the same word-part logic as keyword declarations; call sites (`foo.validateSession(x)`, `if (validateSession(t))`), `==`/`=>` shapes, string literals, and comment mentions stay data.
- Merge gate: find the end of `${...}` interpolations without counting `{` or `}` inside strings, comments, regex literals, or nested templates, so those braces cannot hide a later auth identifier or treat csrf/session regex text as code. `requireAuth()` is a call-shaped auth check.
- Merge gate: strip regex literals inside `${...}` template interpolations for middleware argument scanning and call-shaped auth/session checks, matching top-level regex handling while preserving blocks for real auth identifiers and calls.
- Contributors use pnpm (`packageManager`, `pnpm-lock.yaml`, CI); the package is still published to the npm registry and end users can install with npx/npm/pnpm as before.
- Package-contents guard: source maps no longer ship; a test asserts the npm tarball allowlist and scans it for local paths and secret-shaped strings.
- Add an animated terminal demo GIF (`docs/assets/demo.gif`) recorded from the built CLI via `docs/assets/demo.tape` (VHS); remove the stale static SVG that showed `allow` for the safe sample without a judge key.
- Cursor host adapter (`cursor/.cursor/mcp.json`, `cursor/.cursor/rules/jevladder.mdc`, or `jevladder plugin --host cursor --out .`) adds project MCP launch config and an always-on advisory routing rule. No Cursor lifecycle hooks yet; MCP `jevladder_decide` fails closed without a judge key.
- ZCode host adapter (`zcode/mcp-servers.json`, `zcode/AGENTS.jevladder.md`, or `jevladder plugin --host zcode --out <dir>`) emits global-config fragments under `<dir>/zcode/` with an absolute MCP path for merge into `~/.zcode/cli/config.json`. Advisory only; never writes home config; no ZCode lifecycle hooks.
- Add TypeSafe System One judge (`TypeSafeJudge`) for CLI, default library wiring, and MCP `jevladder_decide` when `JEVLADDER_TYPESAFE_API_KEY` or `TYPESAFE_API_KEY` is set; without a TypeSafe key, fail closed to human (no fixed 0.85 auto-allow). `JEVLADDER_JUDGE_API_KEY` is reserved for `OpenAICompatibleJudge` only — keys are never shared across providers.
- `jevladder propose --open` opens a config-proposal pull request for a human to approve. It never merges. Without `--open`, the command only prints the suggestion.
- `jevladder propose` prints a config suggestion from the privacy-safe decision log. It does not edit config or open a pull request unless `--open` is set. `jevladder check` appends outcome, source, and rule id only.
- OpenCode host adapter (`opencode/jevladder.mjs`) adds advisory routing context, write/merge notes, and the local MCP server. It does not rewrite tool arguments or deny permission.
- Advisory PreToolUse hooks annotate file writes and merge-like shell commands. They do not approve or deny the tool, and they do not log tool input. Enforcement stays in CI/merge.
- Run `pnpm test` and `pnpm run typecheck` on push and pull_request. The workflow does not publish to npm.
- Recognize whole-value env-template placeholders without allowing credential-shaped values through; detect code-shaped auth/session/security changes by content, including in neutral utility paths.
- Prepare the npm package metadata and include generated plugin assets; npm provenance is disabled because CI OIDC is not available.
- Uninspectable binary diffs on unprotected paths return `human` (`uninspectable-binary`) instead of an allow. Protected paths still block first.
- Empty or whitespace-only `scoreRoute` input is rejected. The CLI exits 1 and does not assign a tier.
- Full-line commented prose in env templates (`.env.example` and the other template basenames) is not a `secrets-in-diff` hit. Credential prefixes, private-key headers, and the same comment outside a template still block.

## 0.6.0 — 2026-10-19

- Hardened observer input bounds, log controls, and MCP payload validation with privacy-safe errors.
- Added adversarial coverage for diff injection, path handling, credentials, invalid judge/MCP inputs, and empty CLI/report inputs.
- Documented security boundaries, troubleshooting, and verified plugin uninstall steps.

## 0.5.0 - 2026-10-19

- Added Codex marketplace distribution, automatic advisory hooks, routing skill, and bundled MCP tools.
- Added privacy-safe observe-log cost reporting and independent policy-labelled evaluation.
- Hardened the miniature MCP merge gate against empty/malformed diffs, protected paths, and credential-shaped additions.
