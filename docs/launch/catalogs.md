# Catalog and directory checklist

**Status:** nothing below has been submitted unless a future row is explicitly updated by the maintainer. Default status for every entry: **not submitted**.

Use the one-line descriptions as starting copy; adjust to each form's length limits.

---

## Codex plugin marketplace / discovery

| Item | What it needs | Status | One-line description |
| --- | --- | --- | --- |
| Codex plugin marketplace (repo-hosted) | Marketplace JSON at `.agents/plugins/marketplace.json` pointing at `./plugin`; plugin manifests under `plugin/` (`.codex-plugin/plugin.json`, hooks, MCP, skill). User adds via `codex plugin marketplace add HaraldSigvartsen/jevladder`. | not submitted | JevLadder — rules-first advisory routing and local MCP for Codex; merge enforcement stays in CI. |
| Codex official external catalog | **Verify before submitting** whether Codex maintains a central plugin directory beyond GitHub marketplace URLs and what metadata it requires. | not submitted | Same as above. |

---

## Claude Code plugin marketplace

| Item | What it needs | Status | One-line description |
| --- | --- | --- | --- |
| Claude Code marketplace (repo-hosted) | `.claude-plugin/marketplace.json` at repo root pointing at `./plugin`; generated `plugin/.claude-plugin/plugin.json`, hooks, agents, MCP. Install: `/plugin marketplace add HaraldSigvartsen/jevladder` then `/plugin install jevladder@jevladder`. | not submitted | Advisory routing, fail-open hooks, and local MCP for Claude Code; blocking merges belongs in CI. |
| Anthropic / Claude curated listings | **Verify before submitting** current Claude Code plugin discovery or partner listing process and required fields. | not submitted | Same as above. |

---

## MCP server catalogs

| Item | What it needs | Status | One-line description |
| --- | --- | --- | --- |
| Official MCP registry | **Verify before submitting** — confirm registry URL, submission workflow, and required manifest (server name, transport, tools list, repository URL, license). Bundled server: stdio via `plugin/scripts/jevladder-mcp.mjs`; tools `jevladder_decide`, `jevladder_route`, `jevladder_explain` (decide advisory; route/explain offline). | not submitted | Local stdio MCP for JevLadder: advisory merge check, route scoring, and explanations — no prompt/diff logging. |
| mcp.so | **Verify before submitting** — typical fields: server display name, description, install/config snippet, GitHub link, categories. | not submitted | JevLadder MCP — privacy-safe coding-agent routing and optional fail-closed decide (key required for remote judge). |
| Smithery | **Verify before submitting** — Smithery often wants package name, connection config, tool schema; may expect npm or a published artifact. npm **not published**; may need GitHub/raw install path. | not submitted | Bundled JevLadder stdio MCP from GitHub: route, explain, advisory decide. |
| Glama | **Verify before submitting** listing requirements and whether stdio-only/local servers are accepted. | not submitted | JevLadder — rules-first agent advisor with local MCP tools. |
| PulseMCP | **Verify before submitting** submission form and required metadata. | not submitted | JevLadder MCP server (decide/route/explain) for coding-agent workflows. |

---

## npm

| Item | What it needs | Status | One-line description |
| --- | --- | --- | --- |
| npm registry (`jevladder`) | `package.json` metadata, build artifacts, maintainer npm login (README notes publish pending). CHANGELOG notes CI does not publish to npm. | not submitted | TypeScript merge gate and routing library/CLI for coding agents — rules first, judge for grey zone. |

---

## Awesome lists and community indexes

Submit via PR to each repo; follow their contribution guidelines. **Verify before submitting** that the list still exists and accepts MCP/agent-tool entries.

| Item | What it needs | Status | One-line description |
| --- | --- | --- | --- |
| awesome-mcp-servers | PR: link, short description, category; often requires MCP tool summary and license. | not submitted | JevLadder — stdio MCP with `jevladder_decide`, `jevladder_route`, `jevladder_explain` (local, privacy-safe). |
| awesome-claude-code | PR: plugin/marketplace link, what it automates, honesty about limits. | not submitted | JevLadder Claude Code plugin — advisory routing, observe log without prompt text, CI merge gate separate. |
| awesome-codex (or equivalent Codex plugin list) | **Verify before submitting** exact repo name and inclusion criteria. | not submitted | JevLadder Codex plugin — cheap-first routing skill and voluntary MCP tools. |
| Other agent-tool roundups | **Verify before submitting** each site's form (Product Hunt, BetaList, etc.) — not listed unless maintainer opts in. | not submitted | JevLadder — measurable merge gates and advisory routing for coding agents. |

---

## Pre-submission checklist (maintainer)

- [ ] Claims in listing copy match README / SECURITY only (no invented metrics or users).
- [ ] Hooks described as advisory/fail-open; CI gate as fail-closed.
- [ ] npm described as unpublished unless publish actually happened.
- [ ] Repository URL: https://github.com/HaraldSigvartsen/jevladder
- [ ] License: MIT
