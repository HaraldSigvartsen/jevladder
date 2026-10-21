# Changelog

## Unreleased

- Recognize whole-value env-template placeholders without allowing credential-shaped values through; detect code-shaped auth/session/security changes by content, including in neutral utility paths.
- Prepare the npm package metadata and include generated plugin assets; npm provenance is disabled because CI OIDC is not available.
- Add separately reported, policy-labelled eval scenarios for uninspectable binary diffs and empty route tasks; rule fixes remain queued.
- Add a field-test round 2 known weakness: `secrets-in-diff` fail-closed false positives on commented prose lines in env templates (`.env.example`), labelled `allow` per the independent policy; the eval runner now derives the known-weakness list from task markers instead of hardcoded ids.

## 0.6.0 — 2026-10-19

- Hardened observer input bounds, log controls, and MCP payload validation with privacy-safe errors.
- Added adversarial coverage for diff injection, path handling, credentials, invalid judge/MCP inputs, and empty CLI/report inputs.
- Documented security boundaries, troubleshooting, and verified plugin uninstall steps.

## 0.5.0 - 2026-10-19

- Added Codex marketplace distribution, automatic advisory hooks, routing skill, and bundled MCP tools.
- Added privacy-safe observe-log cost reporting and independent policy-labelled evaluation.
- Hardened the miniature MCP merge gate against empty/malformed diffs, protected paths, and credential-shaped additions.
