# Field test — 2026-10-19

Read-only validation of `jevladder check` against exported git diffs from two of
the maintainer's private local projects. Diffs were written to temporary
files **outside** this repository. No raw diff content, repo names, or
project file paths from those exports are committed here — only generic
diff *types* and synthetic equivalents used in tests.

## Method

1. Export unified diffs (committed ranges and one uncommitted working tree)
   from two private local projects into temp files outside the jevladder repo.
2. Run `jevladder check --diff <tempfile> --tests-passed` (read-only; no merge).
3. Record rule/judge outcomes; classify false positives, false blocks, misses.
4. Fix merge-rules; cover each finding with **generic synthetic** fixtures only.

## Diff types exercised

| Diff type | Outcome (as recorded) | Sensible? |
| --- | --- | --- |
| Small type-fix / annotation-only change | False positive: `secrets-in-diff` blocked on TypeScript types / casts / prose mentioning token (before fix A) | No |
| Large feature change | **Blocked by protected migration path** (`**/migrations/**` / similar) — not “judge grey” | Yes |
| Large content / assistant-feature change | **Blocked by `diff-too-large` (>2000 lines)** — not “judge grey” | Yes |
| Auth / security fix | Miss: files like `auth-guard` / `middleware` escaped `**/auth/**` dir-only globs (before fix C) | No |
| Binary asset change | Paths extracted; no secret false positive on binary notices | Yes |
| Uncommitted working tree (incl. env template) | Before fix B: `.env.example` tripped `protected-paths` via `*.env*`. After fix B: **path no longer protected**, but **content still secret-scanned** — a re-run still blocked via `secrets-in-diff` on a token placeholder / prose-style assignment. Remaining debatable fail-closed false-positive class (template placeholders look credential-shaped). | Path fix yes; content FP debatable |

## Findings (generic)

| ID | Kind | Description |
| --- | --- | --- |
| **A** | False positive | `secrets-in-diff` unquoted branch accepted TypeScript type annotations and expressions (e.g. `Token: string \| null`, `Secret: Uint8Array`, casts with `API_TOKEN: string`, prose with spaces after `token`). Root cause: unquoted values were not restricted to a single credential-shaped token. |
| **B** | False block (path) | `protected-paths` treated env *templates* (`.env.example` / `.sample` / `.template`, including `.env.*.example`) as protected because of `*.env*`. |
| **B′** | Remaining FP class (content) | After B, `.env.example` path alone is not protected, but secrets-in-diff still scans contents. Placeholder / token-shaped assignments in templates can still hard-block — fail-closed, debatable as false positive for commit-safe templates. |
| **C** | Miss | Security-sensitive *filenames* (`auth-guard.ts`, `middleware.ts`, session/csrf helpers) escaped defaults that only matched `**/auth/**` directories. |

## Fixes

- **A** — Unquoted secret values must be a **single** token (no whitespace), length ≥ 8, charset `[A-Za-z0-9_\-./+=]`, not a known type/keyword, not a PascalCase type id (`JwtPayload`), not an ALL_CAPS constant ref without digits (`ACCESS_TOKEN_DEFAULT`; digit-bearing ALL_CAPS like `FAKE_EXAMPLE_ONLY_998273` still blocks), not starting with `(`, `{`, or `<`, and not a member/call expression. Trailing `;`/`,` stripped before analysis. Quoted-literal and token-prefix branches unchanged.
- **B** — `isProtected` excludes env template basenames only (basename-only rule: a directory named `.env.example` does not exempt children such as `.env.example/payments/x.ts`); secrets-in-diff still scans their contents.
- **C** — Default protected globs extended with narrow file patterns: `**/auth-*.*`, `**/*-auth.*`, `**/auth.*`, `**/middleware.*`, `**/session-*.*`, `**/*-session.*`, `**/csrf*.*` (not `**/*auth*`, which would hit `author.ts`).

## After-fix expected outcomes (synthetic)

| Scenario | Expected |
| --- | --- |
| Small type-fix style diff | No secrets rule hit → judge / human grey zone |
| Auth-guard / middleware path | `protected-paths` block |
| Large feature touching migrations | `protected-paths` block (migration path) |
| Large content diff >2000 lines | `diff-too-large` block |
| Working tree `.env.example` path alone | Not protected |
| `.env.example` **content** with fake `DB_PASSWORD=…` / long placeholder tokens | `secrets-in-diff` block (remaining debatable FP for templates) |

## Round 2 — 2026-10-21

Read-only re-run of the same method (exported diffs from two private local
projects, checked outside this repository; no repo names, paths, or diff
contents recorded here).

- **10 real diffs** total: 8 small/medium feature and chore commits, 1
  security-header/middleware commit, 1 large uncommitted working tree.
- The 8 small/medium diffs: all allowed through the judge grey zone (mock
  judge) — sensible.
- The security-header/middleware commit: blocked by `protected-paths`
  (security-sensitive `middleware.*` filename glob) — sensible.
- The large uncommitted working tree: blocked by `secrets-in-diff` on a
  **commented prose line in `.env.example`** — a comment of the shape
  `# KEY_NAME = plain English explanation of the key`, where the first word
  after `=` is a plain lowercase prose word. No credential-shaped value was
  present. This is a **false positive** (fail-closed direction) and is now
  tracked as the `m-env-template-commented-prose` eval case. The
  same working tree would also have hit `new-dependencies` (package.json
  change) and `diff-too-large` (size), both of which are sensible blocks on
  their own. Follow-up: a full-line comment of that shape in an env template
  (`diff --git` file context) is no longer a `secrets-in-diff` hit. Credential-shaped
  comment values still block.

