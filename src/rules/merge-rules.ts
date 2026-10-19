/**
 * Merge-time rule pack for the jev gate.
 *
 * `block` in this pack means "stop and require a human" — it is the safe
 * direction, never a judgment that the change itself is bad. Rules are
 * ordered and the gate's first-hit semantics decide which one wins:
 * tests-not-green, protected-paths, secrets-in-diff, new-dependencies,
 * diff-too-large.
 *
 * Diff text is DATA. Nothing found inside a diff — including text that
 * instructs the agent or the gate to ignore rules — can alter rule
 * outcomes; only explicit machine-checkable patterns matter. Injection
 * strings can never bypass a rule, and a rule hit can never be "allowed"
 * by diff content.
 */
import type { Rule } from '../gate.js';
import { countChangedLines, isAddedDiffLine, isMinusFileHeader, isPlusFileHeader, isRemovedDiffLine, parsePlusHeaderPath } from '../diff-parse.js';

export interface MergeRulesConfig {
  /** Changed-line count that always blocks. Default {@link DEFAULT_MAX_DIFF_LINES_HARD}. */
  maxDiffLinesHard?: number;
  /**
   * Glob patterns for paths that always require human review.
   * Replaces the defaults ({@link DEFAULT_PROTECTED_GLOBS}) entirely.
   */
  protectedGlobs?: string[];
}

export const DEFAULT_PROTECTED_GLOBS: readonly string[] = [
  '**/payments/**',
  '**/auth/**',
  '**/migrations/**',
  '*.env*',
  '**/secrets/**',
];

export const DEFAULT_MAX_DIFF_LINES_HARD = 2000;

/* ------------------------------------------------------------------ *
 * Glob matching (hand-rolled: no runtime dependencies).
 *
 * Supported syntax: `*` matches any characters except `/` within one path
 * segment; `**` as a whole segment matches zero or more segments. Patterns
 * without a `/` are also matched against the file's basename (minimatch's
 * matchBase behavior), so `*.env*` protects nested `.env` files too.
 *
 * Normalization (never fail open on path spelling): backslashes are
 * converted to `/`, leading `./` is stripped (repeatedly), and matching is
 * CASE-INSENSITIVE (both sides lowercased) so `src/Payments`, `src\payments`,
 * and `./src/payments` cannot dodge a protected glob.
 * ------------------------------------------------------------------ */

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDiffPath(path: string): string {
  let normalized = path.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized.toLowerCase();
}

function wildcardMatchSegment(patternSegment: string, segment: string): boolean {
  const source = patternSegment.split('*').map(escapeRegex).join('[^/]*');
  return new RegExp(`^${source}$`).test(segment);
}

function matchSegments(pattern: string[], segments: string[]): boolean {
  if (pattern.length === 0) return segments.length === 0;
  const [head, ...rest] = pattern;
  if (head === '**') {
    for (let skip = 0; skip <= segments.length; skip++) {
      if (matchSegments(rest, segments.slice(skip))) return true;
    }
    return false;
  }
  if (segments.length === 0) return false;
  return (
    wildcardMatchSegment(head, segments[0]) && matchSegments(rest, segments.slice(1))
  );
}

/**
 * Match a file path against a glob pattern (`*`, `**`; no `?`/classes).
 * Paths and patterns are normalized (`\` → `/`, leading `./` stripped) and
 * compared case-insensitively.
 */
export function globMatch(pattern: string, path: string): boolean {
  if (typeof pattern !== 'string' || typeof path !== 'string') return false;
  if (pattern === '') return false;
  const normalizedPattern = normalizeDiffPath(pattern);
  const normalized = normalizeDiffPath(path);
  if (normalized === '') return false;
  const pathParts = normalized.split('/');
  if (!normalizedPattern.includes('/')) {
    const basename = pathParts[pathParts.length - 1] ?? '';
    return matchSegments(normalizedPattern.split('/'), [basename]);
  }
  return matchSegments(normalizedPattern.split('/'), pathParts);
}

/** True when `file` matches any of `globs` (defaults to the protected set). */
export function isProtected(
  file: string,
  globs: readonly string[] = DEFAULT_PROTECTED_GLOBS,
): boolean {
  return globs.some((glob) => globMatch(glob, file));
}

/* ------------------------------------------------------------------ *
 * Diff helpers
 * ------------------------------------------------------------------ */

const SECRET_MATCHERS: ReadonlyArray<{ name: string; re: RegExp }> = [
  {
    name: 'key-like assignment (api key / secret / password / token with a long quoted value)',
    re: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}/i,
  },
  {
    name: 'key-like assignment with a long unquoted value (env style DB_PASSWORD=… / YAML password: …)',
    re: /(api[_-]?key|secret|password|token)\s*[:=]\s*(?!undefined\b|null\b|true\b|false\b|process\.env\.|os\.environ\b|env\.|this\.|[A-Za-z_$][\w$.]*\(|\$\{|\{\{)(?=[^\s'"`]*[0-9]|[^\s'"`]*[^A-Za-z0-9.])[^\s'"`]{8,}/i,
  },
  {
    name: 'private key block header',
    re: /BEGIN\s+[A-Z ]*PRIVATE KEY/,
  },
  {
    name: 'known token prefix (sk- / ghp_ / xoxb- / glpat-) with long payload, or an AWS access key id (AKIA…)',
    re: /\b(?:sk-|ghp_|xoxb-|glpat-)[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b/,
  },
];

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

const DEP_SECTION_RE =
  /"(?:devDependencies|dependencies|optionalDependencies|peerDependencies)"\s*:\s*\{/;
const DEP_ENTRY_RE = /^\s*"([^"]+)"\s*:\s*"[^"]*"\s*,?\s*$/;
const SECTION_CLOSE_RE = /^\s*}\s*,?\s*$/;

/**
 * Find dependencies added by a unified diff. Requires package.json context:
 * either a `+++ b/...package.json` header, or (for headerless snippets) the
 * input's `files` list naming a package.json. Removed lines never contribute.
 */
function findNewDependenciesInDiff(
  diff: string,
  files: readonly string[],
): string[] {
  const deps: string[] = [];
  let currentFile: string | undefined;
  let sawHeader = false;
  let inDepsSection = false;
  const filesIncludePackageJson = files.some((f) => basename(f) === 'package.json');

  for (const rawLine of diff.split(/\r?\n/)) {
    if (isPlusFileHeader(rawLine)) {
      currentFile = parsePlusHeaderPath(rawLine) ?? undefined;
      sawHeader = true;
      inDepsSection = false;
      continue;
    }
    if (isMinusFileHeader(rawLine) || isRemovedDiffLine(rawLine)) continue;

    const added = isAddedDiffLine(rawLine);
    const line = added ? rawLine.slice(1) : rawLine;

    if (DEP_SECTION_RE.test(line)) {
      inDepsSection = true;
      continue;
    }
    if (SECTION_CLOSE_RE.test(line)) {
      inDepsSection = false;
      continue;
    }
    if (!added || !inDepsSection) continue;

    const inPackageJson =
      basename(currentFile ?? '') === 'package.json' ||
      (!sawHeader && filesIncludePackageJson);
    if (!inPackageJson) continue;

    const entry = line.match(DEP_ENTRY_RE);
    if (entry) deps.push(entry[1]);
  }
  return deps;
}

/* ------------------------------------------------------------------ *
 * Rule pack
 * ------------------------------------------------------------------ */

function positiveIntOrThrow(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`makeMergeRules: ${name} must be a positive integer`);
  }
  return value;
}

/**
 * Build the ordered merge-rule pack. Configuration errors throw here
 * (programmer errors); rule evaluation itself never throws.
 */
export function makeMergeRules(config: MergeRulesConfig = {}): Rule[] {
  const opts = config ?? {};

  const maxDiffLinesHard = positiveIntOrThrow(
    'maxDiffLinesHard',
    opts.maxDiffLinesHard,
    DEFAULT_MAX_DIFF_LINES_HARD,
  );

  if (opts.protectedGlobs !== undefined) {
    if (!Array.isArray(opts.protectedGlobs)) {
      throw new TypeError('makeMergeRules: protectedGlobs must be an array of glob strings');
    }
    opts.protectedGlobs.forEach((glob, index) => {
      if (typeof glob !== 'string' || glob.trim() === '') {
        throw new TypeError(
          `makeMergeRules: protectedGlobs[${index}] must be a non-empty string`,
        );
      }
    });
  }
  const globs: readonly string[] = opts.protectedGlobs ?? DEFAULT_PROTECTED_GLOBS;

  const testsNotGreen: Rule = {
    id: 'tests-not-green',
    evaluate: (input) => {
      const testsPassed = input.context?.testsPassed;
      if (testsPassed === true) return null;
      return {
        outcome: 'block',
        reason:
          testsPassed === false
            ? 'tests not green'
            : 'tests status not provided - treated as not green',
      };
    },
  };

  const protectedPaths: Rule = {
    id: 'protected-paths',
    evaluate: (input) => {
      for (const file of input.files ?? []) {
        if (isProtected(file, globs)) {
          return {
            outcome: 'block',
            reason: `protected path requires human review: ${file}`,
            evidence: `matched protected globs [${globs.join(', ')}]`,
          };
        }
      }
      return null;
    },
  };

  const secretsInDiff: Rule = {
    id: 'secrets-in-diff',
    evaluate: (input) => {
      if (typeof input.diff !== 'string' || input.diff === '') return null;
      const lines = input.diff.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined || !isAddedDiffLine(line)) continue;
        const body = line.slice(1);
        for (const { name, re } of SECRET_MATCHERS) {
          if (re.test(body)) {
            return {
              outcome: 'block',
              reason: 'possible secret in diff',
              evidence: `added diff line ${i + 1} matches ${name}; diff text is data and never alters rule outcomes`,
            };
          }
        }
      }
      return null;
    },
  };

  const newDependencies: Rule = {
    id: 'new-dependencies',
    evaluate: (input) => {
      const declared = input.context?.newDependencies;
      if (Array.isArray(declared) && declared.length > 0) {
        const names = declared
          .map((dep) => (typeof dep === 'string' ? dep : JSON.stringify(dep)))
          .join(', ');
        return {
          outcome: 'block',
          reason: `new dependency requires human review: ${names}`,
        };
      }
      if (typeof input.diff === 'string' && input.diff !== '') {
        const deps = findNewDependenciesInDiff(input.diff, input.files ?? []);
        if (deps.length > 0) {
          return {
            outcome: 'block',
            reason: `new dependency requires human review: ${deps.join(', ')}`,
            evidence: 'added in a package.json dependencies section in the diff',
          };
        }
      }
      return null;
    },
  };

  const diffTooLarge: Rule = {
    id: 'diff-too-large',
    evaluate: (input) => {
      if (typeof input.diff !== 'string' || input.diff === '') return null;
      const changed = countChangedLines(input.diff);
      if (changed > maxDiffLinesHard) {
        return {
          outcome: 'block',
          reason: `diff too large: ${changed} changed lines exceeds hard limit ${maxDiffLinesHard}; human review required`,
        };
      }
      return null;
    },
  };

  return [testsNotGreen, protectedPaths, secretsInDiff, newDependencies, diffTooLarge];
}
