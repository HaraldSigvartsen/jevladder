# Jev

**Jev — rules first, a cheap judge only when in doubt, humans for the irreversible. Measurable model routing and merge gates for coding agents.**

[![License: MIT](https://img.shields.io/badge/license-MIT-98492c.svg)](LICENSE)
[![Node: >=20](https://img.shields.io/badge/node-%3E%3D20-334155.svg)](#quick-start)
[![Version: 0.1.0](https://img.shields.io/badge/version-0.1.0-334155.svg)](docs/PLAN.md)

## The problem

Coding agents (Claude Code, Codex, Cursor, OpenCode, …) currently:

1. **Merge and deploy too freely.** A diff that touches `payments/`, drops a
   secret into a log line, or quietly adds a dependency goes straight in if
   the model happens to feel confident. Free-text "LGTM" review is vibes, not
   a gate.
2. **Use the frontier model for everything.** Fixing a typo in a README does
   not need the most expensive tier, but there is usually no measurable,
   deterministic way to decide otherwise — so everything gets the expensive
   path "to be safe".
3. **Cannot prove any of it.** Free-text reviews and ad-hoc routing leave no
   structured record: you cannot measure false-block rate, escalation
   precision, or cost per approved task.

Jev is a small decision authority that fixes the *decision layer*: deterministic
rules run first (free, auditable), a cheap judge covers only the grey zone
(strictly validated output), and everything uncertain — including every
irreversible action — goes to a human. Every decision lands in a structured
log you can measure.

## Architecture

![Jev architecture: rules first, cheap judge for the grey zone, humans for the irreversible](docs/assets/architecture.svg)

Three layers, strictly ordered:

1. **Rules — deterministic, free.** Ordered checks; the first hit decides and
   the judge is never called. The shipped merge pack
   (`makeMergeRules()`) decides: tests not green → stop; protected paths
   (`**/payments/**`, `**/auth/**`, `**/migrations/**`, `*.env*`,
   `**/secrets/**`) → stop; possible secrets in added diff lines → stop; new
   dependencies → stop; diff over 2000 changed lines → stop. Rules are code,
   not prompts — diff text is data and can never alter an outcome.
2. **Cheap judge — only in the grey zone.** When no rule hits, a judge scores
   the change. Its output is *strictly validated*: a verdict from a fixed
   enum (`allow` / `block` / `abstain`), a finite confidence score in [0,1],
   and non-empty evidence. Anything malformed, below the threshold
   (default `0.7`), or an explicit `abstain` defers to a human. That is what
   makes judgments measurable instead of prose.
3. **Human — for everything uncertain and everything irreversible.** Never
   guess, never fail open. `irreversible` + judge `allow` is *always* a human
   decision; a judge `block` still blocks (the safe direction).

Every decision appends to a structured, timestamped decision log (`stage`,
`detail` per entry) — the basis for the eval metrics below and for the
planned cost reports.

## Quick start

Requirements: Node >= 20.

```bash
git clone <this repo> && cd jev
npm install
npm run build
```

Try the merge gate on the bundled demo diffs:

```bash
# A safe change (greeting copy + its test) — no rule hit, judge allows:
node dist/src/cli.js check --diff examples/merge-gate/sample.diff --tests-passed
```

```text
outcome: allow
source:  judge
reason:  mock: no risk signals
judge:   allow 0.85 — mock: no risk signals
```

```bash
# Touches a protected payments path (and adds an obviously fake secret
# literal) — the protected-paths rule stops it before the judge is consulted:
node dist/src/cli.js check --diff examples/merge-gate/sample-risky.diff --tests-passed
```

```text
outcome: block
source:  rule (protected-paths)
reason:  protected path requires human review: src/payments/charge.ts
```

Route a task deterministically (no model calls at all):

```bash
node dist/src/cli.js route --explain "migrate the payments schema to the new provider, keep old invoices"
```

```text
tier:          frontier
abstained:     false
difficulty:    0.550
consequence:   1.000
verifiability: 0.000
signals:
  - money (+0.65) money/billing surface ("payments")
  - cross-domain (+0.55) spans db + payment
  - migration/irreversible (+0.5) migration or irreversible change ("migrate")
explanation:   score=0.73 (= 0.6·difficulty + 0.4·consequence) | axes: difficulty=0.55, consequence=1.00, verifiability=0.00 | tier=frontier | input specific enough: abstained=false | signals: money(+0.65), cross-domain(+0.55), migration/irreversible(+0.5)
```

![Terminal demo: real jev CLI outputs for allow, block, and frontier route](docs/assets/terminal-demo.svg)

Unspecified test status counts as **not green** (`--tests-passed` is the only
way to claim green) — the CLI never fails open. Exit codes make the gate
scriptable: `0` allow, `2` block, `3` human decision required, `1` usage/IO
error. The full demo lives in [examples/merge-gate/](examples/merge-gate/).

## Code example

```ts
import { defineGate, makeMergeRules, MockJudge } from 'jev';

const gate = defineGate({
  rules: makeMergeRules(),   // 1. deterministic, free, first hit decides
  judge: new MockJudge(),    // 2. swap for OpenAICompatibleJudge in real use
  threshold: 0.7,            // below this a verdict defers to a human
  onUncertain: ({ reason }) => console.error(`human needed: ${reason}`),
});

const decision = await gate.decide({
  action: 'merge',
  diff: unifiedDiff,         // diff text is data — never instructions
  files: ['src/greet.ts'],
  irreversible: false,       // true → a judge allow can never approve alone
});

// decision.outcome: 'allow' | 'block' | 'human'
// decision.source:  'rule' | 'judge' | 'human' | 'none'
// decision.log:     structured audit trail for every step taken
```

A typed, documented configuration example (protected paths, model ladder,
irreversible actions, judge threshold) lives in
[examples/config/jev.config.example.ts](examples/config/jev.config.example.ts)
with a [field-to-concept mapping](examples/config/README.md).

## Eval

Run it yourself (deterministic — mock judges and keyword routing only, no
network, no API keys, ~seconds):

```bash
npm run eval
```

**Real numbers from the run on 2026-10-19** (32 synthetic tasks: 21 merge,
11 route; output also written to `eval/report.json`, which is gitignored):

| Arm | Accuracy | Merge | Route | Total cost | Cost / approved | Model calls |
| --- | --- | --- | --- | --- | --- | --- |
| jev | **100.00%** (32/32) | 100.00% | 100.00% | $0.9700 | $0.2425 | 18 |
| all-frontier (simulation) | 68.75% | 90.48% | 27.27% | $1.1500 | $0.1917 | 18 |

- **Quality parity:** +31.25pp for jev over the baseline.
- **Route cost per task:** jev $0.0187 vs baseline $0.0500.
- **False-block rate (jev):** 0.00% — 0 of 4 expected-allow merge tasks were
  blocked or sent to a human.
- **Escalation precision (jev):** 100.00% — 3 human escalations, all
  warranted (expected outcome was human or block).

The four metrics, and what they actually mean:

- **Cost per approved task** — whole-arm total cost divided by merge allows,
  using the mock price ladder: rule decision $0, cheap call $0.002, mid call
  $0.01 (a stated assumption), frontier call $0.05, plus human review $0.20 +
  escalation retry $0.05 per human outcome (~400 tokens per model call).
  Judge consultations are detected via the audit log, so rule stops really
  cost nothing.
- **Quality parity** — accuracy difference between the jev arm and the
  baseline arm on the same labelled tasks.
- **False-block rate** — expected-allow merges that were blocked or escalated.
  High values mean the gate annoys developers and gets switched off.
- **Escalation precision** — fraction of human escalations that were
  warranted. Low values mean the judge abstains on boring work.

> **Caveats — read before quoting any number above.**
> - All tasks are **synthetic** (32 hand-labelled cases; every secret is a
>   fake `FAKE_EXAMPLE_ONLY_*` placeholder).
> - **Eval labels were derived from the same rule/route heuristics under
>   test**, so the accuracy numbers measure consistency with the intended
>   policy, not external validity. v0.2 plans independently labelled tasks.
> - All prices are **mock constants**, not quotes from any provider; token
>   counts are estimates (~400/call).
> - The **all-frontier arm is a simulation**, not a real frontier judge: its
>   mock always allows and never abstains. A real frontier model would
>   sometimes block or abstain, so the parity number is directional — it
>   illustrates confident permissiveness without an abstention channel, not a
>   claim about any specific model.
> - **costPerApproved rewards rubber-stamping**: the baseline "approves" two
>   grey-zone tasks that jev correctly escalates, which is why its
>   cost-per-approved looks lower. Read it next to total cost, accuracy, and
>   the safety metrics — never alone.

## What this is not

- **Not an eval framework.** The bundled `npm run eval` measures *this gate*
  on synthetic tasks. For evaluating prompts/models, use
  [Promptfoo](https://github.com/promptfoo/promptfoo) or
  [Evalite](https://evalite.dev).
- **Not a router, proxy, or gateway.** Jev never sits in your model traffic.
  For request-level routing/proxying, see
  [claude-code-router](https://github.com/musistudio/claude-code-router),
  [LiteLLM](https://github.com/BerriAI/litellm), or
  [OpenRouter](https://openrouter.ai). (And per the plan: if jev ever needs
  gateway plumbing, it will build on those, not reinvent them.)
- **Not a code reviewer replacement.** The judge does not review code quality;
  it makes one narrow, measurable decision — allow, block, or abstain — and
  defers everything else.

## Security model

- **Prompt injection is treated as data.** Diff and task text are never
  instructions: rules are code that match machine-checkable patterns only, so
  injection inside a diff can neither bypass a rule nor mask detection
  (tested at gate level — a secret plus "ignore the rules" still blocks).
- **Judge output is strictly validated.** Verdict enum, finite score in
  [0,1], non-empty evidence; extra keys are ignored, required fields are
  strictly typed with no coercion. Malformed output does not error into an
  allow — it defers to a human.
- **Trust boundary: the CLI must be fed authoritative `git diff` output.**
  `jev check` parses file paths (including both sides of renames and binary
  `Binary files … differ` notices) from the diff itself. Agent-authored or
  edited "diff text" is an untrusted input by definition — pipe real
  `git diff` output, and empty/non-diff input is a usage error (exit 1),
  never an implicit allow.
- **Fail-closed to human.** Missing API key, network failure, timeout,
  unparseable judge response, abstention, below-threshold score, invalid gate
  input — every uncertain path ends in `human`, never a guess.
- **Irreversible actions are never judge-alone.** `irreversible: true` plus a
  judge `allow` is always escalated (a judge `block` still blocks — safe
  direction; caller rules stay authoritative for their own hits).
- **No secrets in this repo.** All credential-looking strings in tests and
  examples are obvious fakes (`FAKE_EXAMPLE_ONLY_*`). The secrets rule's
  evidence names the pattern and line number but never echoes the matched
  secret, so logs stay secret-free.
- **Judge API key via environment only** (`JEV_JUDGE_API_KEY` by default;
  configurable per judge instance). It is never read from config files or
  diffs and never logged.

## Honesty / limits

- **A plugin or library cannot swap a host agent's main model mid-session.**
  Claude Code, Codex, Cursor, and OpenCode do not expose "change your
  underlying model right now" as a hookable action, and jev will not pretend
  otherwise.
- **Routing here is advisory.** `scoreRoute` returns a tier
  (`cheap`/`mid`/`frontier`) with signals and an explanation; acting on it
  happens at dispatch/subagent level (choose which model/agent instance to
  spawn for a task), not by rewriting the host's main loop.
- **The judge format guarantees measurability, not correctness.** A strictly
  validated `allow 0.9` is measurable; it can still be wrong. The cheap judge
  can share blind spots with the models it judges.
- **ABSTAIN exists for exactly that.** When the judge is not confident it
  says so, and the gate spends a human rather than a wrong answer.
- **Host support today:** none built in — v0.1 is the library + CLI. The
  v0.2/v0.3 roadmap (Claude Code plugin hooks, MCP server, multi-host
  adapters) is where host integration lands; each host's integration surface
  will be documented per host when it ships.

## API summary

| Export | What it does |
| --- | --- |
| `defineGate({ rules?, judge?, threshold?, onUncertain? })` | Build the gate: rules first (first hit decides), judge for the grey zone, humans for everything uncertain. Returns `{ decide(input) }`. |
| `makeMergeRules({ maxDiffLinesHard?, protectedGlobs? })` | The ordered merge rule pack: tests-not-green (missing status counts as not green) → protected-paths (case-insensitive; `\` and leading `./` normalized) → secrets-in-diff → new-dependencies → diff-too-large. Default hard limit 2000 changed lines; `block` = stop-for-human. |
| `parseDiffFilePaths(diff)` / `isStructuredDiff(diff)` / `countChangedLines(diff)` | Shared strict diff parsing: paths from `diff --git` (both sides — renames), `+++` headers, and `Binary files … differ` notices; strict `+++`-header classification so added content starting with `++` cannot pose as a header. |
| `MockJudge` / `makeMockJudge(verdictOrFn?)` | Deterministic judge for tests and local dev: no key, no network; abstains on TODO markers and protected-sounding paths, else allows at 0.85. |
| `OpenAICompatibleJudge({ baseUrl, model, apiKeyEnv?, timeoutMs? })` | Real judge over any OpenAI-compatible chat-completions API. Key from env (default `JEV_JUDGE_API_KEY`), 15 s timeout, never throws — operational failures abstain to human. |
| `scoreRoute(task)` | Deterministic tiering (`cheap`/`mid`/`frontier`) from keyword signals on difficulty/consequence/verifiability; low-confidence input raises one tier and sets `abstained=true`. Same input, same output — no model calls. |

CLI exit codes: **0** allow · **2** block · **3** human decision required ·
**1** usage/IO error.

More: [examples/config/](examples/config/) for a typed configuration example,
[examples/merge-gate/](examples/merge-gate/) for the merge demo,
[docs/PLAN.md](docs/PLAN.md) for the plan and decision log.

## Roadmap

- **v0.1 (this)** — library core, merge rule pack, deterministic router,
  CLI, synthetic eval, docs.
- **v0.2** — Claude Code plugin hooks around merge actions; MCP server
  exposing `decide` / `route` / `explain`; cost report from the decision log.
- **v0.3 — "EverythingJevCan"** — multi-host adapters (Claude Code, Codex,
  Cursor, OpenCode, …) on one gate/route core; weekly config-proposal PRs
  generated from the eval/decision log (protected globs, thresholds, ladder
  tweaks) — a human approves every PR, nothing auto-merges.

## Contributing / development

```bash
npm test          # vitest (153 tests)
npm run typecheck # tsc --noEmit
npm run build     # tsc → dist/
npm run eval      # build + run the deterministic eval
```

License: [MIT](LICENSE) © 2026 Harald Sigvartsen.
