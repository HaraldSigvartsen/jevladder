# Show HN draft

**Status:** unpublished draft — do not post without maintainer approval.

## Title (<80 characters)

Show HN: JevLadder — rules-first merge gates and routing for coding agents

(74 characters)

## Post body (~250–350 words)

I built JevLadder, a small decision layer for coding agents: deterministic rules run first (free and auditable), a cheap judge covers only the grey zone, and uncertain or irreversible actions go to a human. Outcomes are measurable — `allow`, `block`, or `human` — instead of free-text "LGTM".

You can use it three ways: a Codex-first advisory plugin (marketplace from GitHub), a TypeScript library, or a CLI merge gate for CI. The maintainer develops and tests on Codex; Claude Code is supported too, validated structurally (manifest validation and hook simulation), not claimed as a live-session proof for every host. OpenCode and Cursor adapters add advisory context and bundled stdio MCP (`jevladder_route` / `jevladder_explain` make no network calls; advisory `jevladder_decide` may call TypeSafe on the grey zone when a judge key is set — compact diff summary only — otherwise human). They do not block tools. Cursor lifecycle hooks are not bundled yet.

In the plugin, hooks are **advisory and fail-open** — they annotate prompts and add context before writes or merge-like shell commands, log only privacy-safe metadata (tier, signals, prompt character count — never prompt text), and never swap the host's main model. **Enforcement** belongs in CI/merge: `jevladder check` blocks on deterministic rules; the grey zone goes to the TypeSafe judge when a key is set, otherwise to human (exit 3) — never silent allow. With TypeSafe keys set, only a compact diff summary is sent to the judge; see the repo's security doc.

The stock CLI, `createDefaultJudge()`, and MCP `jevladder_decide` use the TypeSafe judge. Without a key it abstains (`no judge key configured`). `MockJudge` is explicit in tests and evals only. Set `JEVLADDER_TYPESAFE_API_KEY` or `TYPESAFE_API_KEY` for the bundled path, or wire `OpenAICompatibleJudge` yourself.

Evals in the repo are honest about limits: consistency eval is **100% (35/35)** on labels aligned with the same heuristics under test — that is intended-policy consistency, not external validity. An independent policy-labelled set (33 scenarios) latest run: **25/33 correct (76%)**, with disagreements retained on purpose.

MIT, Node ≥20. Not a model router/proxy (LiteLLM-style), not Promptfoo/Evalite, not a full code-review replacement — one narrow gate decision plus advisory routing.

**Try it (Codex):**

```text
codex plugin marketplace add HaraldSigvartsen/jevladder
codex plugin add jevladder@jevladder
```

CLI/library from GitHub clone until npm publish: https://github.com/HaraldSigvartsen/jevladder

Feedback welcome — especially on false blocks, CI wiring, and where advisory hooks help vs distract.

## Likely questions (honest answers)

**Q: Does the plugin stop bad merges?**  
A: No. Plugin and MCP tools are advisory. Blocking is for your merge gate in CI (`jevladder check`), where missing judge keys fail closed to human review, not silent allow.

**Q: Will it route all my traffic through a cheaper model?**  
A: No. Routing suggests tiers and optional subagents where the host supports delegation; it is not in the inference path and cannot swap the main session model mid-session.

**Q: How good is the judge?**  
A: The judge must return a strict verdict enum plus score and evidence; malformed or uncertain output goes to human. That is not the same as "always correct." Independent eval is 25/33 (76%) against a pre-written policy; consistency eval 35/35 only checks alignment with the shipped heuristics.

**Q: Does it send my prompts to the cloud?**  
A: Observe hooks write locally only. The MCP server runs over stdio on your machine: `jevladder_route` and `jevladder_explain` never call the network. `jevladder_decide` may call TypeSafe on the grey zone when a judge API key is set (compact diff summary only); without a key it returns human. CLI `check` and a custom `OpenAICompatibleJudge` follow the same key/wiring rules.

**Q: npm install?**  
A: Not on npm yet. Use the GitHub marketplace for Codex/Claude plugins, or clone the repo for CLI/library (`npm i -D jevladder` is documented for once publish completes).
