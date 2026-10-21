---
name: jevladder-routing
description: Applies automatically when delegating or choosing effort for coding tasks.
---

# JevLadder routing

JevLadder provides advisory routing for Codex first, with Claude Code also supported.
Call `jevladder_route` or `jevladder_explain` to size a task. Before merge, use `jevladder_decide` as an advisory pre-merge check when available; enforcement stays in CI/merge.
Start specific, well-scoped coding work at cheap effort; delegate automatically
when the host supports it and its instructions allow delegation.

If a tier fails or verification is weak, preserve the error output and escalate
one tier at a time: cheap → mid → frontier. Abstention and uncertainty escalate
up. Reserve frontier for cross-cutting work, unclear causes, or orchestration.
Claude Code can use `jevladder:jevladder-cheap`, `jevladder:jevladder-mid`, and
`jevladder:jevladder-frontier`. The bundled agents/*.md are Claude-only; Codex custom
agents live in ~/.codex/agents as TOML and are not bundled here.

A tier is never permission. Irreversible or uncertain actions go to a human;
the judge never solely approves irreversible actions. Enforcement belongs in
CI/merge outside this session. The main session model is never swapped.
