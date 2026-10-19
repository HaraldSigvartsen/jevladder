# Jev — plan

Working plan for the jev repository. Dates are ISO; "done" means implemented
and verified with `npm test` / `npm run typecheck` / `npm run build` /
`npm run eval`.

## Phases

### v0.1 — core library + CLI + eval (this) — DONE 2026-10-19

- [x] Gate core (`src/gate.ts`): `defineGate` — deterministic rules first
      (first hit decides, judge skipped), strict judge-output validation
      (`parseJudgeVerdict`: verdict enum + finite score in [0,1] + non-empty
      evidence, no coercion), threshold default 0.7, abstain / below-threshold
      / invalid output → human, irreversible + judge allow → always human,
      `onUncertain` callback, structured `DecisionLogEntry` audit log.
      `decide()` never throws; config errors throw at `defineGate` time.
- [x] Judges: `MockJudge` / `makeMockJudge` (deterministic, no key, can
      abstain on TODO / protected-sounding paths) and
      `OpenAICompatibleJudge` (any OpenAI-compatible API, key from env —
      default `JEV_JUDGE_API_KEY`, 15 s timeout, never throws, operational
      failures surface as abstain-like raw objects).
- [x] Merge rule pack (`src/rules/merge-rules.ts`): `makeMergeRules` ordered
      [tests-not-green, protected-paths, secrets-in-diff, new-dependencies,
      diff-too-large]; `block` = stop-for-human; hand-rolled glob matching
      (`*`, `**`, matchBase so `*.env*` covers nested `.env` files); secrets
      rule scans added lines only and never echoes the matched secret;
      diff text is data — injection can neither bypass nor mask detection.
- [x] Deterministic router (`src/route.ts`): `scoreRoute` — keyword signals
      on difficulty / consequence / verifiability, score 0.6·difficulty +
      0.4·consequence, tiers cheap / mid / frontier, low-confidence input
      raises one tier and sets `abstained=true`.
- [x] CLI (`src/cli.ts`): `jev check` (diff from file/stdin, exit 0/2/3) and
      `jev route --explain` (exit 0), `--help` / `--version`, `--json` for
      both commands; unspecified test status counts as not green.
- [x] Eval (`eval/`): 32 labelled synthetic tasks (21 merge, 11 route),
      two arms — JEV vs ALL-FRONTIER baseline simulation (same rules +
      permissive frontier mock) — mock price model, metrics (accuracy,
      parity, cost per approved, false-block rate, escalation precision),
      deterministic `eval/report.json` (gitignored).
- [x] Examples: `examples/merge-gate/` (safe + risky demo diffs),
      `examples/config/` (typed example config + field mapping).
- [x] Docs: README, `docs/assets/architecture.svg`,
      `docs/assets/terminal-demo.svg` (outputs captured from the real CLI),
      LICENSE (MIT).

### v0.2 — Claude Code plugin hooks + MCP + cost report

- [x] Claude Code plugin (observe-only, 2026-10-19): `jev plugin --out`
      generates `.claude-plugin/plugin.json`, `hooks/hooks.json`
      (UserPromptSubmit → `scripts/jev-observe.mjs`), embedded config, and
      README. Annotates prompts with a miniature route tier; never blocks;
      never changes models; log is privacy-safe (no prompt text). Checked-in
      tree under `plugin/` via dogfooded CLI.
- [x] Subagent routing where the host allows it (2026-10-19): generated
      `agents/jev-cheap.md`, `jev-mid.md`, `jev-frontier.md` with configurable
      Claude Code model aliases (defaults haiku / sonnet / inherit).
      UserPromptSubmit suggests the tier's agent; advisory delegation only,
      never blocks or swaps the main session model.
- [ ] Claude Code plugin: hooks wrapping merge-gate checks around agent
      write/merge actions (PreToolUse-style integration) — later in v0.2.
- [ ] MCP server exposing `decide` / `route` / `explain` tools so any
      MCP-capable host can consult the gate.
- [ ] Cost report: cumulative spend by tier from the decision log
      (rule / cheap / mid / frontier / human proxies).

### v0.3 — "EverythingJevCan" multi-host adapters

- [ ] Host adapters (Claude Code, Codex, Cursor, OpenCode, …) sharing one
      gate/route core — routing stays advisory (dispatch/subagent level),
      never a mid-session model swap.
- [ ] Weekly config-proposal PRs generated from the eval/decision log
      (protected globs, thresholds, ladder tweaks). Human approves every PR;
      nothing auto-merges.

## Decision log

| Date | Decision |
| --- | --- |
| 2026-10-19 | Rules first: deterministic, free, first hit decides; the judge is only consulted in the grey zone; humans get everything uncertain. |
| 2026-10-19 | `MockJudge` is the default judge everywhere (tests, CLI, eval) — no key, no network, deterministic; swap in `OpenAICompatibleJudge` for real judging. |
| 2026-10-19 | No gateway/proxy build now; if one is ever needed later, build on LiteLLM / claude-code-router rather than reinventing routing infrastructure. |
| 2026-10-19 | Eval starts synthetic (32 labelled mock tasks, mock prices, permissive-frontier baseline simulation) — directional numbers first, real-model benchmarks later. |
| 2026-10-19 | Irreversible actions always go to a human; a judge allow can never approve them alone (a judge block still blocks — safe direction). |
| 2026-10-19 | Measure daily via the decision log; propose config changes weekly via PRs a human approves — never auto-merge. |

## Continuation log

| Date | Entry |
| --- | --- |
| 2026-10-19 | Field test (docs/FIELDTEST.md): corrected outcomes — large feature diffs blocked by protected migration path; large content diffs blocked by `diff-too-large` (>2000); both sensible (not “judge grey”). After env-template path fix, `.env.example` path is unprotected but content remains secret-scanned (placeholder/token FP class). Independent policy-labelled eval added under `eval/independent/` (`policy.md`, `tasks.ts`, `run.ts`, `npm run eval:independent`); numbers: see README eval section / generated reports — do not invent figures here. |
| 2026-10-19 | v0.2 observe plugin: `src/plugin.ts` + `jev plugin --out` emit Claude Code plugin files; `plugin/` dogfooded from built CLI; UserPromptSubmit observe-only (no block / no model swap); log `~/.jev/observe.jsonl` or `JEV_OBSERVE_LOG` without prompt text. MCP and blocking hooks remain later. |
| 2026-10-19 | Added advisory tier subagents to the generated Claude Code plugin, with YAML frontmatter and config-driven host aliases (haiku / sonnet / inherit defaults; explicit plugin JSON via `--config`). The existing miniature observe scorer suggests an agent; the host decides whether to delegate. No main-session model swap, blocking decision, prompt text in logs, or measured cost-savings claim. Added generation/config/annotation tests and regenerated `plugin/` with the built CLI. |
