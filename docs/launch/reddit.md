# Reddit drafts

**Status:** unpublished — check each sub's current rules, flair requirements, and self-promotion policy before posting. Sub norms change; treat the notes below as reminders, not legal advice.

---

## r/ClaudeAI

**Self-promotion note:** Many AI tool subs allow occasional project posts if you are active in the community, disclose authorship, and focus on discussion rather than a landing-page pitch. Read the sub wiki and recent mod announcements; some require a specific flair or restrict link posts.

**Title draft:**  
JevLadder: advisory routing + local MCP for Claude Code — merge enforcement stays in CI

**Body draft:**

I maintain JevLadder (MIT, GitHub: https://github.com/HaraldSigvartsen/jevladder) — rules first, a judge only in the grey zone, humans for irreversible actions.

For Claude Code, install from the repo marketplace: `/plugin marketplace add HaraldSigvartsen/jevladder` then `/plugin install jevladder@jevladder`. It adds SessionStart guidance, a routing skill, fail-open hooks that never block tools, and voluntary local MCP (`jevladder_route`, `jevladder_explain`, advisory `jevladder_decide`). Hooks log tier/signals/prompt length only — not prompt text.

Important limits (by design):

- Hooks are **advisory**; PreToolUse does not approve/deny writes or `git merge` / `gh pr merge` — it adds context only.
- **CI/merge** is where `jevladder check` can fail closed (no judge key → human, exit 3).
- Claude support here is validated structurally (manifest + hook simulation), not sold as "we proved every live session edge case."
- Stock CLI, `createDefaultJudge()`, and MCP `jevladder_decide` use the TypeSafe judge; without a key it abstains and grey-zone merges go to human. `MockJudge` is explicit in tests/evals only; production judging needs your TypeSafe or custom OpenAI-compatible wiring.

Eval figures from the README only: consistency 35/35 (same-heuristic labels, not external validity); independent policy-labelled 25/33 (76%).

Happy to answer questions about false blocks (e.g. env template placeholders), protected paths, or wiring the gate in GitHub Actions. Not on npm yet — install from GitHub.

---

## r/ChatGPTCoding

**Self-promotion note:** Coding-agent subs often mix tutorials, tooling, and show-and-tell. Prefer a text post with the repo link once, explain what problem you solve, and invite critique. Avoid cross-posting identical text to many subs the same day.

**Title draft:**  
Open-source merge gate for agent workflows: deterministic rules, optional judge, fail-closed in CI

**Body draft:**

Sharing something I've been building for agent-assisted development: **JevLadder** — measurable exits (`allow` / `block` / `human`) for merge safety and cheap-first model-tier routing suggestions.

https://github.com/HaraldSigvartsen/jevladder

Core idea: ordered deterministic rules (tests not green, protected paths, secrets in diff, etc.) run first; only if nothing hits, an optional judge sees a **compact diff summary** (not full files). Irreversible actions always escalate to human even if the judge says allow.

Agent plugins (Codex primary in my workflow; Claude Code supported) add **advisory** hooks — routing context, privacy-safe observe log, local MCP. They fail open and do not block the host. Enforcement is meant for `jevladder check` in CI.

Honest limits: not a LiteLLM/OpenRouter-style proxy; routing does not sit in the inference path. Cursor/OpenCode adapters are advisory templates. npm package `jevladder` is prepared but **not published** — clone or use host marketplace from GitHub.

If you've wired custom "don't merge secrets" automation, I'd like to hear what false positives you tolerate vs fail-closed behavior.

---

## r/programming

**Self-promotion note:** r/programming is strict about blogspam and self-promotion; project announcements often need to be substantive, non-hype, and framed as a technical discussion. Consider a self-post with minimal links and expect moderators to remove thin promotional posts. **Verify current rules before submitting.**

**Title draft:**  
Designing fail-closed merge gates for LLM coding agents (rules-first, judge for grey zone)

**Body draft:**

I've been working on a small TypeScript library/CLI called JevLadder that encodes a pattern I wanted for agent-assisted merges:

1. Deterministic, ordered rules (first hit wins; judge skipped if a rule fires).
2. Strict judge contract (`allow` / `block` / `abstain`, bounded score, non-empty evidence) — parse failures and abstention become **human**, not allow.
3. Irreversible flag forces human even on judge allow.

The agent-facing surface is intentionally **advisory** (fail-open hooks, local MCP that does not log task/diff text). The fail-closed behavior is for automation boundaries (CI running `check` without a key → human).

Repo: https://github.com/HaraldSigvartsen/jevladder (MIT, Node ≥20).

Eval transparency: 35/35 consistency on heuristic-aligned labels (not a claim of real-world accuracy); independent policy-labelled scenarios 25/33 in the latest run, with known disagreements documented.

Discussion questions I'd value from r/programming:

- Where do you draw the line between "helpful pre-merge heuristic" and "false sense of security"?
- Is fail-closed-to-human the right default when no judge key is configured?

(No npm publish yet — source and plugin marketplace live on GitHub.)

---

## Optional: r/LocalLLaMA

**Self-promotion note:** Hardware/local-model subs often prefer posts about running models locally. JevLadder is not a local inference stack; only post here if you frame it as "routing/gating alongside your own models" and expect a skeptical audience. **Verify fit and rules first.**

**Title draft:**  
Not a router — JevLadder gates merges with rules + optional API judge (local MCP tools stay offline)

**Body draft:**

JevLadder (https://github.com/HaraldSigvartsen/jevladder) is **not** a local LLM runtime. It is a decision authority for coding agents: rules first, optional judge on the grey zone, humans for irreversible work.

`jevladder_route` / `jevladder_explain` MCP tools are local with no remote calls. `jevladder_decide` is advisory in the IDE; real enforcement is CI. You can wire `OpenAICompatibleJudge` to your own endpoint and model ladder — JevLadder does not ship a recommended vendor model.

Stock CLI/library path uses the TypeSafe judge via `createDefaultJudge()`; without a key it abstains (`no judge key configured`) and grey-zone merges go to human — not silent allow. `MockJudge` is for tests/evals only.

If you run agents against local models, this might still be useful for **merge policy** separate from **which model answers chat**. Feedback welcome; npm not published yet.
