# JevLadder routing (advisory)

JevLadder sizes coding tasks and suggests effort tiers. Call `jevladder_route` or
`jevladder_explain` when the local MCP server is available. Before merge, use
`jevladder_decide` as an advisory pre-merge check; enforcement stays in CI/merge.

Start specific, well-scoped work at **cheap** effort. If verification is weak or a
tier fails, keep the error output and escalate **one tier at a time**: cheap → mid →
frontier. Reserve frontier for cross-cutting work, unclear causes, or orchestration.

A tier is never permission. Irreversible or uncertain actions go to a human; the judge
never solely approves irreversible actions. The main session model is never swapped.
