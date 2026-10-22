# Changelog

## Unreleased

- Add TypeSafe System One judge (`TypeSafeJudge`) for CLI, default library wiring, and MCP `jevladder_decide` when `JEVLADDER_JUDGE_API_KEY` or `TYPESAFE_API_KEY` is set; without a key, fail closed to human (no fixed 0.85 auto-allow).
- Run `npm test` and `npm run typecheck` on push and pull_request. The workflow does not publish to npm.
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
