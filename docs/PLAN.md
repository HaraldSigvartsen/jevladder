# JevLadder — plan

Working plan for the JevLadder repository. Dates are ISO; "done" means implemented
and verified with `npm test` / `npm run typecheck` / `npm run build` /
`npm run eval`.

## Phases

### v0.4 — Codex-first automatic layer — 2026-10-19

- [x] Dual-host plugin generator emits `.codex-plugin/plugin.json`, bundled
      `.mcp.json`, and dependency-free stdio MCP server alongside legacy files.
- [x] Codex marketplace at `.agents/plugins/marketplace.json` points at
      `./plugin`; the catalog is placed at the required discovery path and its
      strict marketplace test passes.
- [x] Shared fail-open hooks and host-neutral automatic routing skill; honest
      one-time Codex hook trust review (`/hooks`) documented.
- [x] Voluntary local `jevladder_decide` / `jevladder_route` / `jevladder_explain` tools: decide
      is an advisory miniature pre-merge check (enforcement stays in CI/merge);
      no task/diff text logged and no remote calls.
- [x] Codex is the maintainer's primary host; Claude Code is supported as a
      secondary host. Claude agent behavior
      unchanged; Codex custom agents are not bundled.
- [x] Core judge contract, human approval invariants, and false-block metric
      retained unchanged.

### v0.5 — decision tools, measured eval, and maintainer session — 2026-10-19

- [x] Add labelled eval scenarios for known weaknesses; next: rule fixes guided
      by these evals (see `docs/SECURITY.md` and generated eval reports).

- [x] Bump package, CLI fallback, MCP serverInfo, plugin manifests,
      marketplace entries, tests, and README badge to 0.5.0; regenerate
      checked-in plugin from `buildPluginFiles`.
- [x] Bundle advisory `jevladder_decide`, `jevladder_route`, and `jevladder_explain`; cost report
      reads privacy-safe observe logs and labels mock-price estimates simulated.
- [x] Expand independent policy-labelled eval to 31 scenarios without tuning
      rules to labels; latest result is 23/31 (74%) with disagreements retained.
- [x] Real Codex exec session run 2026-10-19 on maintainer machine with jevladder
      plugin installed from GitHub marketplace — SessionStart/UserPromptSubmit
      hooks fired, observe log line written with tier/signals/promptChars only
      (no prompt text), `jevladder_route` MCP tool called by the agent and returned
      `frontier` for a production payments migration description; hook trust
      handled via Codex review flow.
- [x] PreToolUse write/merge hooks — advisory context only; enforcement stays in CI/merge, and the hook never approves or denies the tool.
- [x] Host adapter for OpenCode — advisory plugin module, local MCP, and bundled skill path. Further hosts stay on demand. Weekly config-proposal PRs stay deferred.
- [ ] Weekly config-proposal PRs — defer: needs accumulated real decision logs first.

### v0.3 — Claude Code marketplace + automatic advisory layer — DONE 2026-10-19

- [x] Marketplace metadata at `.claude-plugin/marketplace.json` points to the
      existing generated plugin at `./plugin`; names and version are tested.
- [x] Automatic SessionStart delegation guidance and auto-discovered
      `jevladder-routing` skill; well-scoped tasks start at cheap and escalate one
      tier at a time when verification is weak.
- [x] Fail-open POSIX launcher for both hooks; observe log remains limited to
      privacy-safe UserPromptSubmit metadata.
- [x] Automatic behavior is advisory; irreversible or uncertain work goes to
      a human, and the main session model is never swapped.
- [x] Voluntary MCP `decide` / `route` / `explain` layer is delivered in v0.4.

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
      default `JEVLADDER_JUDGE_API_KEY`, 15 s timeout, never throws, operational
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
- [x] CLI (`src/cli.ts`): `jevladder check` (diff from file/stdin, exit 0/2/3) and
      `jevladder route --explain` (exit 0), `--help` / `--version`, `--json` for
      both commands; unspecified test status counts as not green.
- [x] Eval (`eval/`): 32 labelled synthetic tasks (21 merge, 11 route),
      two arms — JEVLADDER vs ALL-FRONTIER baseline simulation (same rules +
      permissive frontier mock) — mock price model, metrics (accuracy,
      parity, cost per approved, false-block rate, escalation precision),
      deterministic `eval/report.json` (gitignored).
- [x] Examples: `examples/merge-gate/` (safe + risky demo diffs),
      `examples/config/` (typed example config + field mapping).
- [x] Docs: README, `docs/assets/architecture.svg`,
      `docs/assets/terminal-demo.svg` (outputs captured from the real CLI),
      LICENSE (MIT).

### v0.2 — Claude Code plugin hooks + MCP + cost report

- [x] Claude Code plugin (observe-only, 2026-10-19): `jevladder plugin --out`
      generates `.claude-plugin/plugin.json`, `hooks/hooks.json`
      (UserPromptSubmit → `scripts/jevladder-observe.mjs`), embedded config, and
      README. Annotates prompts with a miniature route tier; never blocks;
      never changes models; log is privacy-safe (no prompt text). Checked-in
      tree under `plugin/` via dogfooded CLI.
- [x] Subagent routing where the host allows it (2026-10-19): generated
      `agents/jevladder-cheap.md`, `jevladder-mid.md`, `jevladder-frontier.md` with configurable
      Claude Code model aliases (defaults haiku / sonnet / inherit).
      UserPromptSubmit suggests the tier's agent; advisory delegation only,
      never blocks or swaps the main session model.
- [x] MCP server exposing `jevladder_decide` / `jevladder_route` / `jevladder_explain` tools;
      delivered in v0.4 and expanded in v0.5.
- [x] Cost report: `jevladder report` reads the privacy-safe observe log and reports
      measured tier distribution plus simulated cost by tier and per routed task.

### v0.3 — multi-host adapters

- [x] Host adapter for OpenCode — advisory plugin module, local MCP, and bundled skill path. Further hosts stay on demand. Weekly config-proposal PRs stay deferred.
- [ ] Weekly config-proposal PRs — defer: needs accumulated real decision logs first.

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
| 2026-10-21 | OpenCode host adapter: generated `opencode/jevladder.mjs` exports `JevLadderPlugin`. Advisory system guidance, route note, and post-tool note for writes and merge-like shell commands. Config hook adds the local MCP server and skills path only when absent. No tool-arg rewrite, no permission denial, no prompt or tool-input logging. Weekly config-proposal PRs remain deferred. |
| 2026-10-21 | Advisory PreToolUse hooks for file writes (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `apply_patch`) and merge-like shell commands (`git merge`, `git push`, `git rebase`, `gh pr merge`). Context only: no `permissionDecision`, no tool-input logging. Other shell commands stay silent. |
| 2026-10-21 | Closed the three labelled weaknesses: unprotected binary diffs return human, empty route input is rejected, and commented prose in env templates is not a secrets-in-diff hit. Markers removed; consistency eval 35/35, independent eval 25/33. |
| 2026-10-21 | Field test round 2 (docs/FIELDTEST.md): 10 real diffs from two private projects — 8 allowed via judge grey zone, 1 middleware commit blocked by protected-paths (sensible), 1 working tree blocked by `secrets-in-diff` on a commented prose line in `.env.example` (false positive, fail-closed). Added eval known weakness `m-env-template-commented-prose` (expected `allow` per independent policy M1) plus the eval-runner known-weakness list now derived from task markers; no rule changes. |
| 2026-10-20 | Queue step 2: derive two shared merge-gate improvements from independent policy M1/M2 — allow only obvious whole-value placeholders in secret assignments while retaining credential-shaped blocking, and block code-shaped auth/session/security changes by content on neutral paths. Added unit/adversarial coverage and security limitations; known binary-diff and empty-route weaknesses remain unchanged. |
| 2026-10-19 | v0.5: align all version metadata at 0.5.0; retain the 31-case independent evaluation without rule tuning; Codex live-session verification completed the same day, including hook trust review through Codex review flow. |
| 2026-10-19 | v0.4: primary host changed to Codex; Claude Code supported as a second host. Added dual-host metadata, host-neutral skill/guidance, and voluntary bundled MCP decide/route/explain tools. The catalog is placed at `.agents/plugins/marketplace.json`; strict discovery-path tests pass. |
| 2026-10-19 | Dual-host wording clarified: Codex is the maintainer's primary host and Claude Code is fully supported as a secondary host. The maintainer develops and tests JevLadder on Codex; Claude Code support is validated structurally through manifest validation and hook simulation. |
| 2026-10-19 | v0.3 marketplace distribution and automatic advisory layer: root marketplace points to `./plugin`; SessionStart supplies automatic routing guidance, `jev-routing` is auto-discovered, and both hook events use the fail-open shell launcher. Verified through strict plugin validation and simulation/integration tests; this is not a claim of a real Claude Code session run. MCP is a voluntary layer after this phase. |
| 2026-10-19 | Field test (docs/FIELDTEST.md): corrected outcomes — large feature diffs blocked by protected migration path; large content diffs blocked by `diff-too-large` (>2000); both sensible (not “judge grey”). After env-template path fix, `.env.example` path is unprotected but content remains secret-scanned (placeholder/token FP class). Independent policy-labelled eval added under `eval/independent/` (`policy.md`, `tasks.ts`, `run.ts`, `npm run eval:independent`); numbers: see README eval section / generated reports — do not invent figures here. |
| 2026-10-19 | v0.2 observe plugin: `src/plugin.ts` + `jevladder plugin --out` emit Claude Code plugin files; `plugin/` dogfooded from built CLI; UserPromptSubmit observe-only (no block / no model swap); log `~/.jevladder/observe.jsonl` or `JEVLADDER_OBSERVE_LOG` without prompt text. MCP and blocking hooks remain later. |
| 2026-10-19 | Added advisory tier subagents to the generated Claude Code plugin, with YAML frontmatter and config-driven host aliases (haiku / sonnet / inherit defaults; explicit plugin JSON via `--config`). The existing miniature observe scorer suggests an agent; the host decides whether to delegate. No main-session model swap, blocking decision, prompt text in logs, or measured cost-savings claim. Added generation/config/annotation tests and regenerated `plugin/` with the built CLI. |
