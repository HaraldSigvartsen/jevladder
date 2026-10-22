# Social drafts

**Status:** unpublished. Character counts are for X/Twitter's 280 limit per post.

---

## X (Twitter) thread

**Post 1** (279 chars)  
Introducing JevLadder: rules-first merge gates + advisory routing for coding agents. Deterministic checks first, judge only in the grey zone, humans for irreversible work. Measurable allow/block/human — not "LGTM" prose. MIT, GitHub: https://github.com/HaraldSigvartsen/jevladder

**Post 2** (280 chars)  
Codex plugin: SessionStart, routing skill, fail-open hooks (tier/signals/promptChars — no prompt text). Bundled stdio MCP — route/explain: no network; decide: TypeSafe on grey zone w/ key (compact diff only), else human. Hooks don't block. CI `jevladder check`: rules block first.

**Post 3** (243 chars)  
No judge key → grey zone → human (exit 3 from jevladder check), not silent allow. TypeSafe: compact diff summary only. Stock TypeSafe judge; MockJudge for tests/evals. Claude Code (structural validation); Cursor/OpenCode advisory. npm not yet.

**Post 4** (245 chars)  
Eval honesty: consistency 35/35 = labels match shipped heuristics (not external validity). Independent policy-labelled run 25/33 (76%), disagreements kept on purpose. Not Promptfoo, not LiteLLM — narrow gate + routing hints, not a traffic proxy.

**Post 5** (225 chars)  
Try Codex: `codex plugin marketplace add HaraldSigvartsen/jevladder` then `codex plugin add jevladder@jevladder`. CLI/library: clone repo until `jevladder` hits npm. Threat model in the repo. Feedback on false blocks welcome.

---

## LinkedIn post

I open-sourced **JevLadder** — a small decision layer for coding agents that prioritizes auditable rules over open-ended model opinions.

The pattern is deliberate: run ordered deterministic merge rules first (tests not green, protected paths, secrets in diff, and similar). If nothing fires, an optional judge can weigh the grey zone under a strict contract (allow, block, or abstain — with abstention and parse failures routed to a human). Irreversible actions always require a human, even when a judge would allow.

For day-to-day agent use, JevLadder ships as an advisory plugin (Codex is my primary host; Claude Code is also supported with structural validation). Hooks add routing context and write privacy-safe local metadata; they fail open and do not block tool use. Merge enforcement is meant for CI running `jevladder check`, which fails closed when no judge key is configured.

The project includes a bundled stdio MCP server: `jevladder_route` and `jevladder_explain` make no network calls; advisory `jevladder_decide` may call TypeSafe on the grey zone when a judge key is set (compact diff summary only), otherwise human — it does not replace your CI pipeline. It is explicitly not a model gateway and not a full code-review product — one narrow, measurable decision at a time.

Repository: https://github.com/HaraldSigvartsen/jevladder  
License: MIT. Node ≥20. npm package name `jevladder` is not published yet — install from GitHub or the host marketplace.

If you are wiring agent safety into delivery pipelines, I would value feedback on where fail-closed heuristics help versus where they create noise.
