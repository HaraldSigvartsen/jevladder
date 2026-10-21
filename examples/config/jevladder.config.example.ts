/**
 * Example jevladder configuration — typed, illustrative only.
 *
 * Copy to `jevladder.config.ts` (or import from your own setup code) and edit for
 * your project. Model names are GENERIC PLACEHOLDERS: jevladder does not endorse
 * any provider, and the prices are invented round numbers, not quotes. See
 * examples/config/README.md for how each field maps to gate/route/cli
 * concepts.
 */

import type { JevLadderPluginConfig } from '../../src/plugin.js';

export type ModelTier = 'cheap' | 'mid' | 'frontier';

export interface ModelLadderEntry {
  /** Route tier this entry serves (matches scoreRoute tiers). */
  tier: ModelTier;
  /** Placeholder model identifier — replace with whatever your setup calls. */
  model: string;
  /** Illustrative price per 1M input tokens. */
  inputPer1M: number;
  /** Illustrative price per 1M output tokens. */
  outputPer1M: number;
}

export interface JevLadderConfig {
  /** Passed explicitly to buildPluginFiles/writePluginFiles; not auto-loaded. */
  plugin?: JevLadderPluginConfig;
  /**
   * Glob patterns (`*` within a segment, `**` across segments; slash-free
   * patterns also match basenames) for paths that always require human
   * review. Feeds the protected-paths rule of the merge gate.
   */
  protectedPaths: string[];
  /** Right-sized model per route tier (scoreRoute assigns cheap/mid/frontier). */
  modelLadder: ModelLadderEntry[];
  /**
   * Task phrases that mark an action irreversible. INFORMATIONAL in v0.1:
   * no engine matches these phrases yet — the gate's guard keys off
   * GateInput.irreversible (set today by the CLI's --irreversible flag);
   * v0.2 host hooks plan to map phrases like these automatically. When an
   * input is irreversible, a judge allow can never approve it alone — the
   * decision always defers to a human. `delete *` uses glob-style
   * wildcards for the future matcher.
   */
  irreversibleActions: string[];
  /**
   * Advisory skill/policy documents to load per task type when judging or
   * executing (e.g. style guides for implementation, checklists for review).
   */
  skillsByTaskType: Record<string, string[]>;
  /** Gate judge settings: verdicts below `threshold` defer to a human. */
  judge: {
    threshold: number;
  };
}

export const config: JevLadderConfig = {
  plugin: { subagentModels: { cheap: 'haiku', mid: 'sonnet', frontier: 'inherit' } },
  protectedPaths: [
    '**/payments/**',
    '**/auth/**',
    '**/auth-*.*',
    '**/*-auth.*',
    '**/auth.*',
    '**/middleware.*',
    '**/session-*.*',
    '**/*-session.*',
    '**/csrf*.*',
    '**/migrations/**',
    '*.env*',
    '**/secrets/**',
  ],
  modelLadder: [
    { tier: 'cheap', model: 'example-cheap-model', inputPer1M: 0.5, outputPer1M: 1.5 },
    { tier: 'mid', model: 'example-mid-model', inputPer1M: 2, outputPer1M: 6 },
    { tier: 'frontier', model: 'example-frontier-model', inputPer1M: 10, outputPer1M: 30 },
  ],
  irreversibleActions: ['deploy production', 'run migration', 'delete *'],
  skillsByTaskType: {
    implement: ['coding-standards'],
    review: ['security-review'],
  },
  judge: { threshold: 0.7 },
};
