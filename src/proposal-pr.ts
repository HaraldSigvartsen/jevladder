import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConfigProposal } from './proposal.js';
import { formatConfigProposal } from './proposal.js';

export interface ConfigProposalPullRequest {
  branch: string;
  base: string;
  title: string;
  body: string;
  path: string;
  content: string;
}

export interface CommandRunner {
  (command: string, args: string[], cwd: string): string;
}

const BRANCH = /^jevladder\/config-proposal-\d{4}-\d{2}-\d{2}$/;
const BASE = /^[A-Za-z0-9._/-]+$/;

/** Build the pull request a human approves. Returns null when there is nothing to propose. */
export function configProposalPullRequest(proposal: ConfigProposal, now = new Date(), base = 'main'): ConfigProposalPullRequest | null {
  if (proposal.suggestions.length === 0) return null;
  if (!BASE.test(base) || base.includes('..')) throw new Error('refusing unexpected base branch');
  const day = now.toISOString().slice(0, 10);
  const branch = `jevladder/config-proposal-${day}`;
  const path = `docs/config-proposals/${day}.md`;
  const content = [
    `# Config proposal ${day}`,
    '',
    'A human approves this pull request. Do not auto-merge.',
    'Merging records the suggestion. It does not change gate rules or config.',
    '',
    formatConfigProposal(proposal).trimEnd(),
    '',
  ].join('\n');
  return {
    branch,
    base,
    title: `Config proposal ${day}`,
    body: 'Human approval required. This pull request must not be auto-merged. It records a config suggestion and does not change gate rules.',
    path,
    content,
  };
}

/**
 * Open a pull request and leave it open. The command list has no merge step.
 * `origin/<base>` must already exist.
 */
export function openConfigProposalPullRequest(
  request: ConfigProposalPullRequest,
  options: { cwd: string; run?: CommandRunner },
): { url: string } {
  if (!BRANCH.test(request.branch)) throw new Error('refusing unexpected proposal branch');
  if (!request.path.startsWith('docs/config-proposals/') || request.path.includes('..')) {
    throw new Error('refusing unexpected proposal path');
  }
  if (!BASE.test(request.base) || request.base.includes('..')) throw new Error('refusing unexpected base branch');
  const run = options.run ?? defaultRunner;
  const work = mkdtempSync(join(tmpdir(), 'jevladder-propose-'));
  let added = false;
  try {
    run('git', ['worktree', 'add', '--detach', work, `origin/${request.base}`], options.cwd);
    added = true;
    const file = join(work, request.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, request.content, 'utf8');
    run('git', ['add', '--', request.path], work);
    run('git', ['commit', '-m', request.title], work);
    run('git', ['push', 'origin', `HEAD:refs/heads/${request.branch}`], work);
    const url = run('gh', [
      'pr', 'create',
      '--base', request.base,
      '--head', request.branch,
      '--title', request.title,
      '--body', request.body,
    ], work).trim();
    return { url };
  } finally {
    if (added) {
      try {
        run('git', ['worktree', 'remove', '--force', work], options.cwd);
      } catch {
        // The pull request is already opened or the failure is reported by the caller.
      }
    }
  }
}

function defaultRunner(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
