# Field test — 2026-10-19

Read-only validation of `jev check` against exported git diffs from two of
the maintainer's private local projects. Diffs were written to temporary
files **outside** this repository. No raw diff content, repo names, or
project file paths from those exports are committed here — only generic
diff *types* and synthetic equivalents used in tests.

## Method

1. Export unified diffs (committed ranges and one uncommitted working tree)
   from two private local projects into temp files outside the jev repo.
2. Run `jev check --diff <tempfile> --tests-passed` (read-only; no merge).
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
