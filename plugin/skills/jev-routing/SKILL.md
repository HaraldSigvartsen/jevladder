---
name: jev-routing
description: Applies automatically when delegating or choosing effort for coding tasks.
---

# Jev routing

Jev is advisory routing guidance with sensible defaults. No setup or commands
are needed. Automatically delegate specific, well-scoped coding tasks (for
example, fixing a test, adding a field, or writing a function that follows a
neighbouring pattern) to `jev:jev-cheap` first; do not ask the user before
delegating these tasks.

If a tier fails or verification is weak, preserve the error output and escalate
one tier at a time: `jev:jev-mid`, then `jev:jev-frontier`. Asymmetric
uncertainty escalates up. Reserve frontier for cross-cutting work, unclear
causes, or orchestration.

A tier is never permission. Irreversible or uncertain actions go to a human;
the judge never solely approves irreversible actions. Enforcement belongs in
CI/merge outside this session. The main session model is never swapped.
