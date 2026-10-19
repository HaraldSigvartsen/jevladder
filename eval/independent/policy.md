# Independent merge/route labelling policy

Written criteria for the independently labelled eval set in this directory.
Labels are assigned from the **prose scenario + this policy only**, before any
tierclef run. They are **not** derived from which merge rule, MockJudge marker, or
scoreRoute keyword would fire.

## Labelling method

1. Read the scenario prose (what a thoughtful human would know about the change).
2. Apply M1–M5 (merge) or R1–R4 (route) below; pick exactly one expected outcome.
3. Record `policyRef` (criterion id) and a short `note` justifying the label.
4. Only then may the runner execute tierclef. Disagreement with tierclef is a miss, not a
   reason to retcon the label.

## Merge criteria

Outcomes use the gate vocabulary: `allow` | `block` | `human`.
`block` and `human` both mean “do not auto-merge”; they differ in *why*.

### M1 — Allow (all must hold)

Auto-merge (`allow`) only when the change is **all** of:

- **small** (roughly tens of lines, not hundreds/thousands),
- **reversible** (no one-way / irreversible flag or destructive migrate),
- **tested** (suite green / `testsPassed: true`),
- **non-sensitive** (not auth/session/security middleware, not money/payments,
  not migrations, not real credentials, not new runtime dependencies).

Commit-safe env **templates** (e.g. `.env.example`) with empty values or
obvious placeholders (`<your-…>`, blank assignments) count as non-sensitive
when no credential-shaped secret is present. Biography / docs / CSS outside
sensitive products surfaces are non-sensitive.

### M2 — Block: sensitive non-money surfaces

`block` when the change clearly touches **auth, session, security middleware,
migrations, or credential-bearing config** — including type-only or one-line
edits — because those surfaces are high-stakes even when “small” and tested.

### M3 — Block: hard stop classes

`block` when any of:

- **untested** (tests red or status not provided),
- **secret-looking credential** in the diff (quoted/unquoted assignment of a
  long credential-shaped value — not mere prose mentioning the word password),
- **new runtime dependency**,
- **oversized** diff (added+removed lines **> 2000**), even if generated and
  otherwise mechanical.

Oversized stays `block` under this policy (size alone is enough to stop
auto-merge). A human may still review afterwards; the label is not `human`.

### M4 — Human: money / payments

`human` for **any** change on a payments/money surface (including a tiny
rounding fix or CSS-only tweak under `payments/`). Money always gets a person
in the loop even when tests are green and the edit looks trivial. Path
sensitivity alone is not enough to choose `block` here — the policy prefers
explicit human review.

### M5 — Human: insufficient evidence

`human` when the scenario does not give enough evidence to confidently
`allow` or `block` (e.g. unfinished work markers, unclear scope, grey naming).

## Route criteria

Outcomes: `cheap` | `mid` | `frontier`.

### R1 — Cheap

Narrow, mechanical, well-specified work with low consequence — or a fully
specified **non-code** creative prompt (e.g. “write a haiku about …”).

### R2 — Frontier

Ambiguous **cross-system** work, or anything **destructive / production /
deploy / migration+drop**, or high money+security stakes combined.

### R3 — Mid

Ordinary engineering tasks that are neither R1 nor R2.

### R4 — Mid: underspecified Q&A

Chatty or underspecified questions (“quick question: explain this error”)
without a concrete, mechanical deliverable are **`mid`**, not cheap — even if
they look short. Cheap is reserved for well-specified low-stakes work (R1).

## Limitations

- Small curated set; same author wrote policy, scenarios, and (historically)
  many of tierclef’s heuristics — high agreement can be circular, not proof of
  generalisation.
- Synthetic diffs and fake placeholders only; no private repos or real secrets.
- MockJudge + deterministic scoreRoute only — not a live frontier model.
- `block` vs `human` is a labelling distinction; both refuse auto-merge. Misses
  that swap the two still matter for measuring exact outcome fidelity.
