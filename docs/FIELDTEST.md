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

| Diff type | Outcome before fix | Sensible? |
| --- | --- | --- |
| Small type-fix / annotation-only change | False positive: `secrets-in-diff` blocked on TypeScript types / casts / prose mentioning token | No |
| Large feature change | Judge grey zone (expected when no rule hits) | Yes |
| Large content / assistant-feature change | Judge grey zone or size-aware path (no hard block under 2000) | Yes |
| Auth / security fix | Miss: files like `auth-guard` / `middleware` escaped `**/auth/**` dir-only globs | No |
| Binary asset change | Paths extracted; no secret false positive on binary notices | Yes |
| Uncommitted working tree (incl. env template) | False block: `.env.example` tripped `protected-paths` via `*.env*` | No |

## Findings (generic)

| ID | Kind | Description |
| --- | --- | --- |
| **A** | False positive | `secrets-in-diff` unquoted branch accepted TypeScript type annotations and expressions (e.g. `Token: string \| null`, `Secret: Uint8Array`, casts with `API_TOKEN: string`, prose with spaces after `token`). Root cause: unquoted values were not restricted to a single credential-shaped token. |
| **B** | False block | `protected-paths` treated env *templates* (`.env.example` / `.sample` / `.template`, including `.env.*.example`) as protected because of `*.env*`. |
| **C** | Miss | Security-sensitive *filenames* (`auth-guard.ts`, `middleware.ts`, session/csrf helpers) escaped defaults that only matched `**/auth/**` directories. |

## Fixes

- **A** — Unquoted secret values must be a **single** token (no whitespace), length ≥ 8, charset `[A-Za-z0-9_\-./+=]`, not a known type/keyword, not starting with `(`, `{`, or `<`, not containing `|<>{}()[];,`, and not a member/call expression. Quoted-literal and token-prefix branches unchanged.
- **B** — `isProtected` excludes env template basenames; secrets-in-diff still scans their contents.
- **C** — Default protected globs extended with narrow file patterns: `**/auth-*.*`, `**/*-auth.*`, `**/auth.*`, `**/middleware.*`, `**/session-*.*`, `**/*-session.*`, `**/csrf*.*` (not `**/*auth*`, which would hit `author.ts`).

## After-fix expected outcomes (synthetic)

| Scenario | Expected |
| --- | --- |
| Small type-fix style diff | No secrets rule hit → judge / human grey zone |
| Auth-guard / middleware path | `protected-paths` block |
| Working tree `.env.example` path alone | Not protected |
| `.env.example` **content** with fake `DB_PASSWORD=…` | `secrets-in-diff` block |
