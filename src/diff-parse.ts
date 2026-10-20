/**
 * Shared unified-diff parsing helpers.
 *
 * One source of truth for recognizing diff structure, so the CLI and the
 * rule pack cannot disagree about what counts as a header, a changed line,
 * or a file path.
 *
 * Header classification is strict on purpose (never fail open): a `+++`/`---`
 * line is a header ONLY when it parses as `+++ (b/)?path` / `--- (a/)?path`
 * (or `/dev/null`), optionally followed by a tab and a timestamp. A line like
 * `+++password=...` has no space after `+++` and is therefore CONTENT — added
 * content starting with `++` cannot evade secrets scanning or the changed-line
 * count by rendering as a fake header.
 */

/**
 * Matches a valid `+++` header: `+++` + whitespace + optional `b/` + path
 * (or `/dev/null`), optionally followed by a TAB and a timestamp suffix.
 * Space-separated trailing content makes the line INVALID (treated as
 * content) so payloads cannot hide behind a plausible path.
 */
const PLUS_HEADER_RE = /^\+\+\+[ \t](?:b\/)?(\/dev\/null|[^\t\n\r ]+)(?:\t[^\n\r]*)?$/;

/** Mirrors {@link PLUS_HEADER_RE} for the `--- a/...` side. */
const MINUS_HEADER_RE = /^---[ \t](?:a\/)?(\/dev\/null|[^\t\n\r ]+)(?:\t[^\n\r]*)?$/;

/** `diff --git a/<old> b/<new>` header (paths may differ on rename). */
const GIT_HEADER_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** Parsed both-side paths of a strict `diff --git a/<old> b/<new>` header. */
export interface GitHeaderPaths {
  oldPath: string;
  newPath: string;
}

/**
 * Parse a `diff --git a/<old> b/<new>` header into both paths, or `null`
 * when the line does not parse unambiguously. Quoted paths and paths with
 * spaces do NOT parse (treated as unparseable by callers — fail closed to
 * an ordinary file with no exemptions).
 */
export function parseGitDiffHeader(line: string): GitHeaderPaths | null {
  const match = line.match(GIT_HEADER_RE);
  if (!match || !match[1] || !match[2]) return null;
  return { oldPath: match[1], newPath: match[2] };
}

/** `Binary files a/<old> and b/<new> differ` notice. */
const BINARY_HEADER_RE = /^Binary files a\/(\S+) and b\/(\S+) differ$/;

/**
 * True when the line is a `+++` file header in the strict format above.
 * `+++ b/x`, `+++ /dev/null`, `+++ x` (no prefix) are headers;
 * `+++password=…`, `+++` alone, `+++ b/x trailing words` are content.
 */
export function isPlusFileHeader(line: string): boolean {
  return PLUS_HEADER_RE.test(line);
}

/** True when the line is a strict `---` file header (see {@link isPlusFileHeader}). */
export function isMinusFileHeader(line: string): boolean {
  return MINUS_HEADER_RE.test(line);
}

/**
 * Extract the path from a strict `+++` header line, or `null` when the line
 * is not a header (or is `+++ /dev/null`, which carries no target path).
 */
export function parsePlusHeaderPath(line: string): string | null {
  const match = line.match(PLUS_HEADER_RE);
  const path = match?.[1];
  if (!path || path === '/dev/null') return null;
  return path;
}

/** True for added-content lines (`+…`) that are NOT strict `+++` headers. */
export function isAddedDiffLine(line: string): boolean {
  return line.startsWith('+') && !isPlusFileHeader(line);
}

/** True for removed-content lines (`-…`) that are NOT strict `---` headers. */
export function isRemovedDiffLine(line: string): boolean {
  return line.startsWith('-') && !isMinusFileHeader(line);
}

/** Count added + removed content lines (headers excluded). */
export function countChangedLines(diff: string): number {
  let count = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (isAddedDiffLine(line) || isRemovedDiffLine(line)) count++;
  }
  return count;
}

/**
 * True when the text looks like a unified diff at all: at least one
 * `diff --git` line, strict `+++` header, or `@@` hunk marker. Used by the
 * CLI to reject empty or garbage input instead of failing open.
 */
export function isStructuredDiff(text: string): boolean {
  if (typeof text !== 'string' || text === '') return false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('diff --git ') || line.startsWith('@@ ') || isPlusFileHeader(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract every changed file path from a unified diff:
 * `+++ b/…` headers, `diff --git a/… b/…` (BOTH sides, so renames keep the
 * old protected path), and `Binary files a/… and b/… differ` notices.
 * Order-preserving, de-duplicated, `/dev/null` skipped.
 */
export function parseDiffFilePaths(diff: string): string[] {
  const files: string[] = [];
  const push = (file: string | undefined): void => {
    if (file && file !== '/dev/null' && !files.includes(file)) files.push(file);
  };

  if (typeof diff !== 'string') return files;
  for (const rawLine of diff.split(/\r?\n/)) {
    const plusPath = parsePlusHeaderPath(rawLine);
    if (plusPath !== null) {
      push(plusPath);
      continue;
    }
    const git = rawLine.match(GIT_HEADER_RE);
    if (git) {
      push(git[1]);
      push(git[2]);
      continue;
    }
    const binary = rawLine.match(BINARY_HEADER_RE);
    if (binary) {
      push(binary[1]);
      push(binary[2]);
    }
  }
  return files;
}
