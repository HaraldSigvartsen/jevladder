# jev — code review log

## Round 1 — 2026-10-19 — GLM-5.3 via OpenCode (read-only) — verdict: CHANGES

Read-only review of src/, test/, eval/, examples/, README, package.json.
Findings: blockers B1–B2, should-fixes S1–S8 (subset recorded here).

## Round 2 — 2026-10-19 — Cursor auto (independent, read-only) — verdict: CHANGES

Independent re-review; B1/B2 confirmed unreproduced-in-tests-but-live, new
blocker B3 (binary/headerless diffs yield no `+++` headers so protected
paths never fire), plus S6 soft-limit "config theater" and S8 library
testsPassed-undefined fail-open.

## Findings addressed (2026-10-19 fix pass)

### Blockers (all fixed)

- **B1 CLI fails open on empty/garbage diff.** `jev check --diff /dev/null
  --tests-passed` previously returned `allow` exit 0. Fix: `runCheck`
  (src/cli.ts) now rejects empty diffs and non-diff input (no
  `diff --git` / strict `+++` / `@@` line) with a usage error, exit 1;
  stdin read failures surface as explicit errors (exit 1, never coerced to
  `''`); a TTY stdin with no `--diff` errors out instead of hanging.
- **B2 `++` content evasion via fake `+++` headers.** `isAddedLine` treated
  any `+++…` as a header, so added content starting with `++` (renders
  `+++password=…`) escaped secrets-in-diff and the changed-line count. Fix:
  strict header classification in src/diff-parse.ts — `+++`/`---` are
  headers only in `+++ (b/)?path` / `--- (a/)?path` (or `/dev/null`)
  form, optionally followed by TAB + timestamp; anything else is content
  and is scanned/counted. Regression tests in test/merge-rules.test.ts and
  test/diff-parse.test.ts.
- **B3 binary/headerless diffs bypass protected paths.** `extractDiffFiles`
  only parsed `+++` headers; binary files and pure renames carry none. Fix:
  new shared module src/diff-parse.ts (exported from the package) parses
  `diff --git a/X b/Y` (BOTH sides — a rename away from payments keeps the
  old protected path) and `Binary files a/X and b/Y differ`; the CLI uses
  `parseDiffFilePaths` + `isStructuredDiff` from it. Tests: binary payments
  diff blocks (exit 2), rename out of payments blocks (exit 2).

### Should-fixes (all fixed)

- **S1 glob bypass via casing/backslashes/`./`.** `globMatch`/`isProtected`
  (src/rules/merge-rules.ts) now normalize `\`→`/`, strip leading `./`
  repeatedly, and compare case-insensitively (both pattern and path are
  lowercased). Documented in the module header. Tests: `src/Payments`,
  `src\payments\x.ts`, `.ENV`, `./src/payments/…`.
- **S3 unquoted secrets + token prefixes.** Secrets matcher accepts
  unquoted values ≥8 chars after `=` or `:` (`DB_PASSWORD=…`, YAML
  `password: …`), tuned to avoid benign code (`undefined`/`null`/booleans/
  `process.env.`/`env.`/`this.`/call expressions/template placeholders, and
  letter+dot-only member chains). Added prefixes `AKIA[0-9A-Z]{16}`,
  `xoxb-`, `glpat-`. Fake examples only in tests.
- **S6 `maxDiffLinesSoft` was config theater** (evidence-string only, no
  control flow). Removed the option, its validation, and its advertising;
  only the hard limit remains (`maxDiffLinesHard`, default 2000). README
  and tests updated.
- **S7 `route --explain --json` ate the flag.** A `--explain` value
  starting with `--` is now a usage error (exit 1); `--json` parses in any
  position (same guard applied symmetrically to `--diff`).
- **S8 merge rules failed open when `testsPassed` missing.** tests-not-green
  now hits whenever `context.testsPassed !== true`; reason distinguishes
  `'tests status not provided - treated as not green'` from
  `'tests not green'`. Eval tasks already set `testsPassed` explicitly (kept
  explicit rather than weakening the rule); eval numbers unchanged.

### Docs

- README: judge-validation wording fixed to "extra keys ignored; required
  fields strictly typed, no coercion" (S4).
- README eval caveats: added explicit label-circularity caveat — eval
  labels derive from the same heuristics under test, so accuracy measures
  consistency with intended policy, not external validity; v0.2 plans
  independently labelled tasks (S5).
- README security model: trust-boundary note — `jev check` must be fed
  authoritative git diff output, not agent-authored text; paths parsed from
  `diff --git` headers including renames/binary.
- examples/config README + example config: louder note that
  `irreversibleActions` is informational in v0.1 (no engine enforces it;
  the gate uses `input.irreversible`).

### Rejected nits (not done, with reasons)

- **Separate build tsconfig for eval/examples**: rejected — eval/ and
  examples/ are intentionally compiled by the same config (rootDir ".",
  include covers them; emitted to dist/eval etc.), and the package `files`
  field already limits what is published to `dist/src`. A second tsconfig
  adds surface without changing the published artifact.
- **`repository`/`exports` in package.json**: ACCEPTED (trivially correct):
  added `repository` (git+https://github.com/HaraldSigvartsen/jev.git) and
  `exports` (`.` → types `dist/src/index.d.ts`, import `dist/src/index.js`);
  `npm pack --dry-run` verified: tarball still contains only LICENSE,
  README.md, package.json, dist/src/**.

## Re-verification (2026-10-19 fix pass)

- `npm run typecheck` — clean.
- `npm test` — 153 tests, 7 files, all passing (121 before; +32 regression
  tests for B1/B2/B3/S1/S3/S6/S7/S8).
- `npm run build` — clean.
- `npm run eval` — unchanged numbers: jev 100.00% (32/32; merge 100.00%,
  route 100.00%), baseline 68.75% (merge 90.48%, route 27.27%), parity
  +31.25pp, jev total cost $0.9700, cost/approved $0.2425, 18 model calls;
  false-block 0.00%, escalation precision 100.00%. README eval table still
  accurate.
- CLI demos: empty diff → exit 1; garbage diff → exit 1; TTY stdin without
  --diff → exit 1 (no hang); safe diff → allow 0; payments diff → block 2;
  binary payments diff → block 2; rename out of payments → block 2;
  `route --explain --json` → exit 1; `route --json … --explain <text>` → 0.
- `npm pack --dry-run` — clean (27 files, dist/src only).

RESULTS (supervisor-verified 2026-10-19, after fixes):
- `npm test` — 153/153 passed (7 files; incl. 13 new diff-parse tests,
  merge-rules 45, cli 27).
- `npm run typecheck` — clean.
- `npm run build` — clean.
- `npm run eval` — unchanged numbers: jev 100% (32/32) vs all-frontier
  68.75%, parity +31.25pp; costPerApproved jev $0.2425 vs baseline
  $0.1917; false-block 0%; escalation precision 100% (3/3).
- Manual blocker re-verification: `check --diff /dev/null` → exit 1
  (empty diff refused); non-diff stdin → exit 1; safe sample → allow /
  exit 0; risky payments sample → block / exit 2.
- Verdict after fixes: ready for v0.1 publish pending final grep/pack
  checks.

## Round 3 — 2026-10-19 — Cursor auto review of post-v0.1 diff — verdict: CHANGES

Read-only review of the post-v0.1 / observe-plugin diff. **No blockers.**
Two SHOULD-FIX items plus a type-identifier false-positive class on
unquoted secrets; fixes applied in this pass.

### Should-fixes (fixed)

- **Env-template nested path escape.** Template exclusion is
  **basename-only**: a directory named `.env.example` must not exempt
  children. `.env.example/payments/x.ts` stays protected via
  `**/payments/**`; `.env.example/secret.key` is not path-protected
  (no matching glob — not a fail-open via template exemption). Documented
  on `isEnvTemplatePath` / `isProtected`; regression tests added.
- **`JevLadderPluginConfig.logFileName` unwired.** Observe script now embeds the
  sanitized basename (`~/.jevladder/<logFileName>`); basename-only, slash-strip,
  fallback to `observe.jsonl` on weird input. Config + README stay
  consistent. `JEVLADDER_OBSERVE_LOG` env override always wins (documented).
- **Unquoted secret FPs on type ids / constant refs.**
  `token: JwtPayload;`, `password: PasswordHash;`,
  `const token = ACCESS_TOKEN_DEFAULT;` no longer block (PascalCase type
  identifier; ALL_CAPS without digits = constant ref). Trailing `;`/`,`
  stripped before analysis. Digit-bearing ALL_CAPS
  (`FAKE_EXAMPLE_ONLY_998273`) still blocks.

### Version coherence

- package.json / package-lock / CLI `--version` fallback bumped to
  **0.2.0** (plugin section already advertised 0.2).

### Plugin validation (supervisor fact)

Supervisor live-validated with:

`claude plugin validate plugin` = Validation passed

### Rejected / accepted nits (brief)

- **Rejected:** inventing path protection for arbitrary names under a
  template-named directory (e.g. forcing `.env.example/secret.key` to
  block without a matching glob) — would broaden globs without a
  security rationale; children are evaluated normally.
- **Accepted:** basename-only template rule + payments-under-template-dir
  regression; wire `logFileName`; PascalCase / digit-free ALL_CAPS skip;
  version bump to 0.2.0; regenerate checked-in `plugin/`.
- **Deferred (label hygiene, not this pass):** independent-eval M1/M3
  label stretches noted in prior review — out of scope for these
  SHOULD-FIXes.
