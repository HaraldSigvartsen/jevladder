/**
 * Compact unified-diff summary for external judge APIs. Never includes full
 * file contents — only paths, line counts, and a truncated changed-line excerpt.
 */
import type { GateInput } from '../gate.js';

export const DEFAULT_DIFF_SUMMARY_MAX_CHARS = 2000;

export interface CompactDiffSummary {
  fileCount: number;
  files: string[];
  linesAdded: number;
  linesRemoved: number;
  excerpt: string;
}

export function buildCompactDiffSummary(
  diff: string,
  maxTotal = DEFAULT_DIFF_SUMMARY_MAX_CHARS,
): CompactDiffSummary {
  const lines = diff.split('\n');
  const files = new Set<string>();
  let linesAdded = 0;
  let linesRemoved = 0;
  const changed: string[] = [];

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(\S+) b\/(\S+)$/);
      if (match?.[2]) files.add(match[2]);
    } else if (line.startsWith('+++ ')) {
      const path = line.slice(4).split('\t')[0]?.replace(/^b\//, '') ?? '';
      if (path && path !== '/dev/null') files.add(path);
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      linesAdded += 1;
      changed.push(line);
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      linesRemoved += 1;
      changed.push(line);
    }
  }

  const fileList = [...files].slice(0, 40);
  const base = {
    fileCount: files.size,
    files: fileList,
    linesAdded,
    linesRemoved,
    excerpt: '',
  };

  const metaLen = JSON.stringify({ ...base, excerpt: '' }).length;
  let budget = maxTotal - metaLen - 24;
  if (budget < 80) budget = 80;

  let excerpt = '';
  for (const line of changed) {
    const next = excerpt === '' ? line : `${excerpt}\n${line}`;
    if (next.length > budget) {
      if (excerpt === '') excerpt = line.slice(0, budget);
      excerpt += '\n…[excerpt truncated]';
      break;
    }
    excerpt = next;
  }

  return { ...base, excerpt };
}

/** Minimal `state` object for TypeSafe System One merge judging. */
export function buildTypeSafeJudgeState(input: GateInput): Record<string, unknown> {
  const diff = typeof input.diff === 'string' ? input.diff : '';
  const summary = buildCompactDiffSummary(diff);
  return {
    action: input.action,
    irreversible: input.irreversible === true,
    fileCount: summary.fileCount,
    files: summary.files,
    linesAdded: summary.linesAdded,
    linesRemoved: summary.linesRemoved,
    excerpt: summary.excerpt,
  };
}
