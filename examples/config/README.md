# jev config example

`jev.config.example.ts` is a typed, self-contained example configuration.
Everything in it is illustrative: model names are generic placeholders (jev
endorses no provider) and prices are invented round numbers, not quotes.

Copy it to `jev.config.ts` and adapt it, or import the pieces you need into
your own setup code. Each field maps to an existing jev concept:

## Field mapping

| Field | Maps to | Effect |
| --- | --- | --- |
| `protectedPaths` | `makeMergeRules({ protectedGlobs })` → the `protected-paths` rule | Any changed file matching a glob makes the merge gate `block` (stop for human review). Glob syntax: `*` within a segment, `**` across segments; slash-free patterns also match basenames, so `*.env*` covers nested `.env` files. Matching is case-insensitive with `\` converted to `/` and leading `./` stripped (both pattern and path), so `src/Payments`, `src\payments`, and `./src/payments` cannot dodge a glob. Replaces the defaults entirely. |
| `modelLadder` | `scoreRoute` tiers (`cheap` / `mid` / `frontier`) | `scoreRoute(task)` assigns a tier deterministically; the ladder says which model runs the task at that tier and what it costs. The eval runner uses flat per-call mock prices instead, but the tier names are the same contract. |
| `irreversibleActions` | `GateInput.irreversible` + the gate's irreversibility guard, surfaced by the CLI's `--irreversible` flag | **Informational in v0.1 — no engine enforces this list yet.** The gate's guard keys off `input.irreversible`, which today only the CLI's `--irreversible` flag sets; nothing maps these task phrases to that input automatically (v0.2 host hooks will). When an input IS irreversible, a judge `allow` can never approve it alone — the decision always becomes `human`. A judge `block` still blocks (the safe direction), and rule hits stay authoritative. |
| `skillsByTaskType` | Advisory context for judges/agents (extension point) | Which skill or policy documents to load per task type (style guides for `implement`, checklists for `review`) so judges and agents share the same standards. Informational today — the gate itself ignores it. |
| `judge.threshold` | `defineGate({ threshold })` (default `0.7`) | Judge verdicts scoring below the threshold are not acted on: the gate defers to a human rather than guessing. |

## Related entry points

- Gate: `defineGate({ rules, judge, threshold })` from `src/gate.ts`
- Merge rules: `makeMergeRules()` from `src/rules/merge-rules.ts`
- Router: `scoreRoute(task)` from `src/route.ts`
- CLI: `jev check --diff <file> [--irreversible] [--tests-passed]`, `jev route --explain "<task>"`

All values here are examples — tune them to your project.
