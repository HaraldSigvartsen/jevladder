# Social drafts

**Status:** unpublished. Character counts are for X/Twitter's 280 limit per post.

---

## X (Twitter) thread

**Post 1** (279 chars)  
Introducing JevLadder: rules-first merge gates + advisory routing for coding agents. Deterministic checks first, judge only in the grey zone, humans for irreversible work. Measurable allow/block/human — not "LGTM" prose. MIT, GitHub: https://github.com/HaraldSigvartsen/jevladder

**Post 2** (278 chars)  
Codex plugin from repo: SessionStart guidance, routing skill, fail-open hooks (tier/signals/promptChars only — never prompt text). MCP: jevladder_route, jevladder_explain, advisory jevladder_decide. Hooks don't block. CI check: rules block; grey zone → judge w/ key, else human.

**Post 3** (280 chars)  
No judge API key → grey zone → human (exit 3), not silent allow. TypeSafe keys send only a compact diff summary. Stock path is TypeSafe judge (not a mock); MockJudge is for tests/evals. Claude Code supported (structural validation); Cursor/OpenCode adapters advisory. npm not yet.

**Post 4** (245 chars)  
Eval honesty: consistency 35/35 = labels match shipped heuristics (not external validity). Independent policy-labelled run 25/33 (76%), disagreements kept on purpose. Not Promptfoo, not LiteLLM — narrow gate + routing hints, not a traffic proxy.

**Post 5** (242 chars)  
Try Codex: `codex plugin marketplace add HaraldSigvartsen/jevladder` then `codex plugin add jevladder@jevladder`. CLI/library: clone repo until `jevladder` hits npm. Security/threat model in docs/SECURITY.md. Feedback on false blocks welcome.

---

## LinkedIn post

I open-sourced **JevLadder** — a small decision layer for coding agents that prioritizes auditable rules over open-ended model opinions.

The pattern is deliberate: run ordered deterministic merge rules first (tests not green, protected paths, secrets in diff, and similar). If nothing fires, an optional judge can weigh the grey zone under a strict contract (allow, block, or abstain — with abstention and parse failures routed to a human). Irreversible actions always require a human, even when a judge would allow.

For day-to-day agent use, JevLadder ships as an advisory plugin (Codex is my primary host; Claude Code is also supported with structural validation). Hooks add routing context and write privacy-safe local metadata; they fail open and do not block tool use. Merge enforcement is meant for CI running `jevladder check`, which fails closed when no judge key is configured.

The project includes local MCP tools for routing and explanation, plus an advisory pre-merge check that does not replace your pipeline. It is explicitly not a model gateway and not a full code-review product — one narrow, measurable decision at a time.

Repository: https://github.com/HaraldSigvartsen/jevladder  
License: MIT. Node ≥20. npm package name `jevladder` is not published yet — install from GitHub or the host marketplace.

If you are wiring agent safety into delivery pipelines, I would value feedback on where fail-closed heuristics help versus where they create noise.
