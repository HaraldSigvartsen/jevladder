/**
 * Merge-time rule pack for the jevladder gate.
 *
 * `block` in this pack means "stop and require a human" — it is the safe
 * direction, never a judgment that the change itself is bad. Rules are
 * ordered and the gate's first-hit semantics decide which one wins:
 * tests-not-green, protected-paths, uninspectable-binary, secrets-in-diff,
 * sensitive-content, new-dependencies, diff-too-large.
 * `uninspectable-binary` returns `human` (not `block`): the bytes are not in
 * the diff, so the gate must not guess `allow`.
 *
 * Diff text is DATA. Nothing found inside a diff — including text that
 * instructs the agent or the gate to ignore rules — can alter rule
 * outcomes; only explicit machine-checkable patterns matter. Injection
 * strings can never bypass a rule, and a rule hit can never be "allowed"
 * by diff content.
 */
import type { Rule } from '../gate.js';
import { countChangedLines, isAddedDiffLine, isMinusFileHeader, isPlusFileHeader, isRemovedDiffLine, parseBinaryDiffNotice, parseGitDiffHeader, parsePlusHeaderPath } from '../diff-parse.js';

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
];

/**
 * Basenames that look like env *templates* (safe to commit) — never path-protected.
 * Multi-component node-env spellings are recognized (`DOTENV_CONFIG_EXTEND`-style
 * convention): `.env.production.local.example`, `.env.development.sample`,
 * `.env.staging.template`, etc. Basename-only: a directory named `.env.example`
 * must NOT exempt children (e.g. `.env.example/payments/x.ts` is still protected
 * via the payments glob). Real env files (`.env`, `.env.local`, `.env.production`)
 * never match — only the explicit example/sample/template/dist suffix counts.
 */
const ENV_TEMPLATE_BASENAME_RE =
  /^(?:\.env(?:\.[^.]+)*|[^/]+\.env)\.(?:example|sample|template|dist)$/i;

/**
 * True only when the file's own basename is an env template name.
 * Ancestor path segments are ignored — nested files are evaluated normally.
 */
export function isEnvTemplatePath(file: string): boolean {
  const normalized = normalizeDiffPath(file).replace(/\/+$/, '');
  if (normalized === '') return false;
  const base = normalized.split('/').pop() ?? normalized;
  if (base === '') return false;
  return ENV_TEMPLATE_BASENAME_RE.test(base);
}

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

/**
 * True when `file` matches any of `globs` (defaults to the protected set).
 * Env-template exclusion is basename-only ({@link isEnvTemplatePath}): a
 * directory named `.env.example` does not exempt children. Nested files are
 * matched against globs on their own path (e.g. a payments path under a
 * template-named dir still blocks). Arbitrary names like
 * `.env.example/secret.key` stay unprotected unless a glob matches.
 */
export function isProtected(
  file: string,
  globs: readonly string[] = DEFAULT_PROTECTED_GLOBS,
): boolean {
  // Env template *files* are commit-safe scaffolding; secret *content* is
  // still scanned by secrets-in-diff. Basename-only — never exempt children.
  if (isEnvTemplatePath(file)) return false;
  return globs.some((glob) => globMatch(glob, file));
}

/* ------------------------------------------------------------------ *
 * Diff helpers
 * ------------------------------------------------------------------ */

const QUOTED_SECRET_RE =
  /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}/i;

/** Key + separator for unquoted env/YAML-style assignments; value checked separately. */
const UNQUOTED_SECRET_KEY_RE = /(api[_-]?key|secret|password|token)\s*[:=]\s*/gi;

/** Single-token credential-shaped literal (no whitespace). */
const UNQUOTED_LITERAL_TOKEN_RE = /^[A-Za-z0-9_\-./+=]{8,}/;

/**
 * STRICT whole-line env-template placeholder assignment (fail closed).
 * The ENTIRE added line (after the leading `+`) must match: optional
 * whitespace, optional `export`, KEY `[A-Za-z_][A-Za-z0-9_]*`, `=`, and a
 * VALUE that is exactly one of:
 *   - empty
 *   - `""` or `''` (empty quoted)
 *   - `<lowercase words/underscores/hyphens/spaces>`
 *   - `"<same lowercase angle text>"` (double-quoted only)
 *   - `changeme` / `CHANGEME`
 *   - `your_..._here` style (any case)
 *   - repeated `x` mask (`xxx`, `xxxx`, …)
 * NOTHING else may appear on the line: no trailing comment, no trailing
 * text, no second assignment. Anything else falls through to the full
 * ordinary matcher set. Credential-prefix and private-key matchers run on
 * every line regardless (see SECRET_MATCHERS).
 */
const ENV_TEMPLATE_PLACEHOLDER_LINE_RE =
  /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:""|''|<[a-z_\- ]+>|"<[a-z_\- ]+>"|changeme|CHANGEME|[Yy][Oo][Uu][Rr]_[A-Za-z0-9_]*_[Hh][Ee][Rr][Ee]|[Xx]{3,})?\s*$/;

/**
 * Full-line dotenv comment whose only key-like assignments are prose:
 * `# KEY = longlivedaccess token from the settings page`.
 * The value's first word is lowercase letters (8+), and more words follow.
 * A digit, a capital, a lone token, a known credential prefix, or a
 * private-key header is not prose. Callers still run always-on matchers.
 */
function isCommentedProseLine(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed.startsWith('#')) return false;
  const comment = trimmed.slice(1);
  const keyRe = /(api[_-]?key|secret|password|token)\s*[:=]\s*/gi;
  let match: RegExpExecArray | null;
  let sawAssignment = false;
  while ((match = keyRe.exec(comment)) !== null) {
    sawAssignment = true;
    const after = comment.slice(match.index + match[0].length);
    if (!/^[a-z]{8,}\s+[A-Za-z]/.test(after)) return false;
  }
  return sawAssignment;
}

/**
 * Types/keywords/placeholders that look long enough to trip a naive unquoted
 * matcher but are never credentials (TypeScript annotations, JS literals, etc.).
 */
const NON_SECRET_UNQUOTED_TOKENS = new Set(
  [
    'undefined',
    'null',
    'true',
    'false',
    'string',
    'number',
    'boolean',
    'bigint',
    'symbol',
    'object',
    'any',
    'unknown',
    'never',
    'void',
    'uint8array',
    'int8array',
    'uint16array',
    'int16array',
    'uint32array',
    'int32array',
    'float32array',
    'float64array',
    'biguint64array',
    'bigint64array',
    'arraybuffer',
    'sharedarraybuffer',
    'dataview',
    'promise',
    'array',
    'record',
    'readonly',
    'partial',
    'required',
    'pick',
    'omit',
    'exclude',
    'extract',
    'nonnullable',
    'returntype',
    'parameters',
    'instanceof',
    'typeof',
  ].map((t) => t.toLowerCase()),
);

/** `foo.bar.baz` member chains (credential charset allows `.`, so reject these). */
const MEMBER_EXPRESSION_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;

/** PascalCase type identifier (single word, has a lowercase letter). */
const PASCAL_CASE_TYPE_RE = /^[A-Z][a-zA-Z]*$/;

/** ALL_CAPS constant reference (letters/underscores only — no digits). */
const ALL_CAPS_CONSTANT_RE = /^[A-Z][A-Z_]*$/;

/** True for `JwtPayload` / `PasswordHash`-style type names (not credentials). */
function isPascalCaseTypeIdentifier(token: string): boolean {
  return PASCAL_CASE_TYPE_RE.test(token) && /[a-z]/.test(token);
}

/**
 * True for `ACCESS_TOKEN_DEFAULT`-style constant refs (ALL_CAPS, no digits).
 * Tokens with digits (`FAKE_EXAMPLE_ONLY_998273`) stay credential-shaped.
 */
function isAllCapsConstantReference(token: string): boolean {
  return ALL_CAPS_CONSTANT_RE.test(token);
}

function isUnquotedSecretLiteral(body: string): boolean {
  UNQUOTED_SECRET_KEY_RE.lastIndex = 0;
  let keyMatch: RegExpExecArray | null;
  while ((keyMatch = UNQUOTED_SECRET_KEY_RE.exec(body)) !== null) {
    const after = body.slice(keyMatch.index + keyMatch[0].length);
    // Quoted branch owns quote-delimited values; skip so we do not double-hit.
    const first = after[0];
    if (first === "'" || first === '"' || first === '`') continue;
    // Not a literal: type/cast/object/generic punctuation.
    if (first === '(' || first === '{') continue;

    const tokenMatch = after.match(UNQUOTED_LITERAL_TOKEN_RE);
    if (!tokenMatch) continue;
    // Strip trailing `;` / `,` if present on the matched span (statement /
    // property punctuation) so `token: JwtPayload;` analyses the identifier.
    const token = tokenMatch[0].replace(/[;,]+$/, '');
    if (token.length < 8) continue;
    if (NON_SECRET_UNQUOTED_TOKENS.has(token.toLowerCase())) continue;
    if (isPascalCaseTypeIdentifier(token)) continue;
    // ALL_CAPS without digits → constant ref (skip); with digits → credential.
    if (isAllCapsConstantReference(token)) continue;

    const rest = after.slice(tokenMatch[0].length).replace(/^[ \t]*[;,]/, '');
    // Call expression: `token = getSecret(` / member then call.
    if (rest.startsWith('(')) continue;
    if (MEMBER_EXPRESSION_RE.test(token)) continue;
    // `process.env.` / `foo.` incomplete member continuing past the charset stop.
    if (
      /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(token) &&
      /^\.[A-Za-z_$]/.test(rest)
    ) {
      continue;
    }

    return true;
  }
  return false;
}

/**
 * Secret matchers. `alwaysApplies` matchers (private-key headers and known
 * credential token prefixes) run over the COMPLETE line and take precedence
 * over the env-template placeholder exemption: a credential-shaped token or
 * a private-key header is never exempt, even inside `API_KEY="<...>"`,
 * after a trailing `# comment`, or inside angle-bracket placeholder text.
 * The remaining matchers are the ordinary assignment checks that the
 * placeholder exemption can suppress.
 */
const SECRET_MATCHERS: ReadonlyArray<{
  name: string;
  test: (body: string) => boolean;
  alwaysApplies?: boolean;
}> = [
  {
    name: 'key-like assignment (api key / secret / password / token with a long quoted value)',
    test: (body) => QUOTED_SECRET_RE.test(body),
  },
  {
    name: 'key-like assignment with a long unquoted value (env style DB_PASSWORD=… / YAML password: …)',
    test: isUnquotedSecretLiteral,
  },
  {
    name: 'private key block header',
    test: (body) => /BEGIN\s+[A-Z ]*PRIVATE KEY/.test(body),
    alwaysApplies: true,
  },
  {
    name: 'known token prefix (sk- / ghp_ / xoxb- / glpat-) with long payload, or an AWS access key id (AKIA…)',
    test: (body) =>
      /\b(?:sk-|ghp_|xoxb-|glpat-)[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b/.test(body),
    alwaysApplies: true,
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

/* ------------------------------------------------------------------ *
 * Sensitive-content helpers
 * ------------------------------------------------------------------ */

/**
 * Middleware identifier prefixes that indicate auth/session/CSRF logic.
 * Auth spellings are constrained (auth / authn / authz / authenticate /
 * authentication / authorize / authorization and British spellings) so
 * `authorsRouter` and `author` (public content, not auth) stay exempt.
 */
const MIDDLEWARE_AUTH_PREFIX_RE =
  /^(?:csrf|auth(?:n|z|enticated?|entication|orized?|orization|orised?|orisation)?|session)/i;

/**
 * A matched identifier continues the auth word only when the next character
 * is a lowercase letter or digit (case-sensitive on purpose): `authMiddleware`,
 * `auth_middleware`, and `AUTH_MIDDLEWARE` count; `authorsRouter` and `author`
 * do not.
 */
function isAuthMiddlewareIdentifier(id: string): boolean {
  const match = id.match(MIDDLEWARE_AUTH_PREFIX_RE);
  if (!match) return false;
  const next = id[match[0].length];
  return next === undefined || next === '_' || next === '$' || !/[a-z0-9]/.test(next);
}

/**
 * Scan `source[start, end)` with the same string/comment awareness used for
 * argument extraction, and return the surviving code text:
 * - string-literal contents (single/double quotes) are stripped,
 * - `//` and `/* *​/` comment contents are stripped,
 * - template-literal TEXT is stripped, while `${...}` interpolation
 *   expressions are RECURSIVELY scanned with this same function, so nested
 *   templates, nested strings, comments, and regex literals inside
 *   interpolations are handled identically to top-level code.
 */
function scanCodeRegion(source: string, start: number, end: number): string {
  let out = '';
  let prev = '';
  let i = start;
  while (i < end) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      out += ' ';
      while (i < end && source[i] !== '\n') i++;
      prev = '/';
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      out += ' ';
      i += 2;
      while (i < end && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 1;
      prev = '/';
      continue;
    }
    if (ch === '"' || ch === "'") {
      out += ' ';
      i++;
      while (i < end && source[i] !== ch) {
        if (source[i] === '\\') i++;
        i++;
      }
      prev = ch;
      continue;
    }
    if (ch === '`') {
      out += ' ';
      i++;
      while (i < end && source[i] !== '`') {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '$' && source[i + 1] === '{') {
          let braceDepth = 1;
          let j = i + 2;
          while (j < end && braceDepth > 0) {
            if (source[j] === '{') braceDepth++;
            else if (source[j] === '}') {
              braceDepth--;
              if (braceDepth === 0) break;
            }
            j++;
          }
          out += ' ' + scanCodeRegion(source, i + 2, j);
          i = j + 1;
          continue;
        }
        i++;
      }
      prev = '`';
      continue;
    }
    if (ch === '/' && source[i + 1] !== '/' && source[i + 1] !== '*' && regexCanStartAfter(prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < end) {
        const c = source[j];
        if (c === '\n') break;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        out += ' ';
        i = j + 1;
        while (i < end && /[A-Za-z]/.test(source[i])) i++;
        prev = '/';
        continue;
      }
    }
    out += ch;
    prev = ch;
    i++;
  }
  return out;
}

/**
 * True when a `/` at the current position may START a regex literal rather
 * than being a division operator: division can only follow an identifier,
 * number, closing paren/bracket, or member dot.
 */
function regexCanStartAfter(prev: string): boolean {
  return prev === '' || !/[\w$)\].]/.test(prev);
}

/**
 * Return `body` with the contents of regex literals replaced by a space, for
 * call-shaped checks that otherwise run on the raw diff line: regex source
 * like `/auth(?:ors)?/` or `/session(.*)/` is pattern DATA, not a function
 * call, so `auth(` or `session(` inside it must not look call-shaped.
 * Strings and template-literal static text are preserved verbatim (no
 * loosening of what already matched there); regex literals are removed in
 * top-level code and inside `${...}` interpolation expressions. A `/` starts
 * a regex when division is impossible ({@link regexCanStartAfter}), and the
 * literal must close on the same line (with `[...]` classes and `\` escapes
 * respected); otherwise the `/` is left untouched.
 */
function stripRegexLiterals(body: string): string {
  let out = '';
  let prev = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    // Quoted strings: preserved verbatim (contents are data, but they already
    // matched before this change, so keep prior behavior intact).
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < body.length) {
        if (body[j] === '\\') {
          j += 2;
          continue;
        }
        if (body[j] === ch) {
          j++;
          break;
        }
        if (body[j] === '\n') break;
        j++;
      }
      out += body.slice(i, j);
      prev = body[j - 1] ?? ch;
      i = j;
      continue;
    }
    // Template literals: static text preserved; `${...}` expressions recurse.
    if (ch === '`') {
      out += ch;
      let j = i + 1;
      while (j < body.length) {
        if (body[j] === '\\') {
          out += body.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (body[j] === '`') {
          out += '`';
          j++;
          break;
        }
        if (body[j] === '\n') break;
        if (body[j] === '$' && body[j + 1] === '{') {
          let braceDepth = 1;
          let k = j + 2;
          while (k < body.length && braceDepth > 0) {
            if (body[k] === '{') braceDepth++;
            else if (body[k] === '}') {
              braceDepth--;
              if (braceDepth === 0) break;
            }
            k++;
          }
          out += '${' + stripRegexLiterals(body.slice(j + 2, k)) + '}';
          j = k + 1;
          continue;
        }
        out += body[j];
        j++;
      }
      prev = '`';
      i = j;
      continue;
    }
    // Comments: contents are data; blank them so a `/` sequence cannot
    // confuse regex detection downstream.
    if (ch === '/' && body[i + 1] === '/') {
      while (i < body.length && body[i] !== '\n') i++;
      out += ' ';
      prev = '/';
      continue;
    }
    if (ch === '/' && body[i + 1] === '*') {
      let j = i + 2;
      while (j < body.length && !(body[j] === '*' && body[j + 1] === '/')) j++;
      i = j + 2;
      out += ' ';
      prev = '/';
      continue;
    }
    // Regex literal: must close on this line; contents are dropped.
    if (ch === '/' && body[i + 1] !== '/' && body[i + 1] !== '*' && regexCanStartAfter(prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < body.length) {
        const c = body[j];
        if (c === '\n') break;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        out += ' ';
        i = j + 1;
        while (i < body.length && /[A-Za-z]/.test(body[i])) i++;
        prev = '/';
        continue;
      }
    }
    out += ch;
    prev = ch;
    i++;
  }
  return out;
}

/**
 * Extract the argument list of a call whose opening parenthesis starts at
 * `openParenIndex` (the index of `(`), for parenthesis balancing purposes:
 * - `//` and `/* *​/` comment contents are IGNORED (a `)` inside a comment
 *   must not terminate the argument list), and are stripped from the result.
 * - String literal contents (single/double quotes) are stripped from the
 *   result so route text like `"/session"` never yields identifiers.
 * - Template-literal TEXT is treated as a string (stripped), but the
 *   expressions inside `${...}` interpolations are KEPT and scanned with the
 *   same string/comment-aware lexer ({@link scanCodeRegion}), so identifiers
 *   there still count while interpolation strings/comments do not.
 * - Regex literal contents (e.g. `/session/`) are excluded from identifier
 *   scanning and parenthesis balancing: their text is not read as code and
 *   a `)` or identifier inside a regex cannot affect the argument list.
 * Returns the surviving argument text, or `null` when unbalanced. Stopping
 * at the FIRST closing parenthesis (a naive `[^\)]*` capture) would
 * truncate argument lists like `app.use("/api", logger(), authMiddleware)`.
 */
function extractBalancedCallArguments(body: string, openParenIndex: number): string | null {
  let depth = 1;
  let args = '';
  let prev = '';
  for (let i = openParenIndex + 1; i < body.length; i++) {
    const ch = body[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      args += ch;
      continue;
    }
    // Line comments: ignored entirely up to (not including) end of line.
    if (ch === '/' && body[i + 1] === '/') {
      args += ' ';
      while (i < body.length && body[i] !== '\n') i++;
      prev = '/';
      continue;
    }
    // Block comments: ignored entirely, including any parens inside.
    if (ch === '/' && body[i + 1] === '*') {
      args += ' ';
      i += 2;
      while (i < body.length && !(body[i] === '*' && body[i + 1] === '/')) i++;
      i += 1;
      prev = '/';
      continue;
    }
    // Single/double-quoted strings: contents stripped.
    if (ch === '"' || ch === "'") {
      args += ' ';
      i++;
      while (i < body.length && body[i] !== ch) {
        if (body[i] === '\\') i++;
        i++;
      }
      prev = ch;
      continue;
    }
    // Template literals: text stripped, ${...} expressions scanned with the
    // same string/comment-aware lexer (recursing into nested templates).
    if (ch === '`') {
      args += ' ';
      i++;
      while (i < body.length && body[i] !== '`') {
        if (body[i] === '\\') {
          i += 2;
          continue;
        }
        if (body[i] === '$' && body[i + 1] === '{') {
          let braceDepth = 1;
          let j = i + 2;
          while (j < body.length && braceDepth > 0) {
            if (body[j] === '{') braceDepth++;
            else if (body[j] === '}') {
              braceDepth--;
              if (braceDepth === 0) break;
            }
            j++;
          }
          args += ' ' + scanCodeRegion(body, i + 2, j);
          i = j + 1;
          continue;
        }
        i++;
      }
      prev = '`';
      continue;
    }
    // Regex literals: contents excluded from identifier scanning and paren
    // balancing. A `/` is only a regex start when division is impossible.
    if (ch === '/' && body[i + 1] !== '/' && body[i + 1] !== '*' && regexCanStartAfter(prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < body.length) {
        const c = body[j];
        if (c === '\n') break;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        args += ' ';
        i = j + 1;
        while (i < body.length && /[A-Za-z]/.test(body[i])) i++;
        prev = '/';
        continue;
      }
    }
    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) return args;
    }
    args += ch;
    prev = ch;
  }
  return null;
}

/**
 * True when the body calls sign/verify with a jwt/token-shaped argument and
 * the call is NOT on the exact `Math` receiver (whitespace allowed around
 * the dot: `Math.sign`, `Math . sign`, `Math. sign`). Any OTHER receiver —
 * `crypto.verify(token)`, `session.verify(token)`, `jwt.verify(...)` — and
 * any bare standalone call are detected.
 */
const MATH_RECEIVER_RE = /(?:^|[^\w$])Math\s*\.\s*$/;

function isStandaloneSignVerifyWithJwtToken(body: string): boolean {
  const callRe = /\b(?:sign|verify)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(body)) !== null) {
    const prefix = body.slice(0, match.index);
    if (MATH_RECEIVER_RE.test(prefix)) continue;
    const args = body.slice(match.index + match[0].length).split(/[)\n]/)[0] ?? '';
    if (/\b(?:jwt|token)\b/i.test(args)) return true;
  }
  return false;
}

/** True for `app/router/server . use(...)` middleware registrations carrying auth/session identifiers. */
function registersAuthMiddleware(body: string): boolean {
  const useCallRe = /\b(?:app|router|server)\s*\.\s*use\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = useCallRe.exec(body)) !== null) {
    const args = extractBalancedCallArguments(body, match.index + match[0].length - 1);
    if (args === null) continue;
    // Comments and string/template-literal text are already stripped by the
    // extractor; only surviving code tokens (including `${...}` expression
    // text) are scanned as identifiers.
    const identifiers = args.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
    if (identifiers.some(isAuthMiddlewareIdentifier)) return true;
  }
  return false;
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

  const uninspectableBinary: Rule = {
    id: 'uninspectable-binary',
    evaluate: (input) => {
      if (typeof input.diff !== 'string' || input.diff === '') return null;
      for (const line of input.diff.split(/\r?\n/)) {
        if (!parseBinaryDiffNotice(line)) continue;
        return {
          outcome: 'human',
          reason: 'binary diff content cannot be inspected; human review required',
          evidence: 'Binary files notice — never guess allow when the bytes are absent',
        };
      }
      return null;
    },
  };

  const secretsInDiff: Rule = {
    id: 'secrets-in-diff',
    evaluate: (input) => {
      if (typeof input.diff !== 'string' || input.diff === '') return null;
      const lines = input.diff.split(/\r?\n/);
      // File context comes ONLY from `diff --git` headers. `+++`/`---` lines
      // are ignored for context (header-shaped added content cannot spoof
      // template state), and any unparseable or absent header means the file
      // is treated as an ordinary source file: no exemptions, full scanning.
      let currentFile: string | undefined;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        if (line.startsWith('diff --git ')) {
          const parsed = parseGitDiffHeader(line);
          currentFile = parsed ? parsed.newPath : undefined;
          continue;
        }
        if (!isAddedDiffLine(line)) continue;
        const body = line.slice(1);
        // Credential-prefix and private-key checks run over the COMPLETE
        // line first and always block; the placeholder exemption only ever
        // suppresses the ordinary assignment matchers.
        const templateFile = currentFile !== undefined && isEnvTemplatePath(currentFile);
        const templatePlaceholder = templateFile && ENV_TEMPLATE_PLACEHOLDER_LINE_RE.test(body);
        const templateCommentProse = templateFile && isCommentedProseLine(body);
        for (const { name, test, alwaysApplies } of SECRET_MATCHERS) {
          if (!test(body)) continue;
          if (!alwaysApplies && (templatePlaceholder || templateCommentProse)) continue;
          return {
            outcome: 'block',
            reason: 'possible secret in diff',
            evidence: `added diff line ${i + 1} matches ${name}; diff text is data and never alters rule outcomes`,
          };
        }
      }
      return null;
    },
  };

  const sensitiveContent: Rule = {
    id: 'sensitive-content',
    evaluate: (input) => {
      if (typeof input.diff !== 'string' || input.diff === '') return null;
      const lines = input.diff.split(/\r?\n/);
      // Same fail-closed file context as secrets-in-diff: derived ONLY from
      // `diff --git` headers, fully reset at every header line (so a later
      // source file never inherits a previous file's Markdown exclusion),
      // with absent/unparseable headers treated as an ordinary source file.
      let oldFile: string | undefined;
      let newFile: string | undefined;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        if (line.startsWith('diff --git ')) {
          const parsed = parseGitDiffHeader(line);
          oldFile = parsed?.oldPath;
          newFile = parsed?.newPath;
          continue;
        }
        if (!isAddedDiffLine(line) && !isRemovedDiffLine(line)) continue;
        const body = line.slice(1);
        const changedFile = isRemovedDiffLine(line) ? oldFile : newFile;
        if (changedFile?.toLowerCase().endsWith('.md')) continue;
        if (/(?:session|token)\s*(?:\.\s*)?(?:expires?|expiry|expiration|lifetime|maxage|ttl)\s*(?:[:=]|\+=|-=)/i.test(body) ||
            /(?:maxage|ttl)\s*[:=][^\n]*(?:session|token)/i.test(body) ||
            /\b(?:jwt|jsonwebtoken)\s*\.\s*(?:sign|verify)\s*\(/i.test(body) ||
            isStandaloneSignVerifyWithJwtToken(body) ||
            /(?:password|passwd)[^\n]*(?:hash|compare|verify)\s*\(|(?:hash|compare|verify)\s*\([^\n]*(?:password|passwd)/i.test(body) ||
            /\b(?:hasPermission|canAccess|authorize|isAuthorized|checkPermission|requireRole|hasRole)\s*\(/i.test(body) ||
            /\b(?:csrf\w*|auth(?:\b|entication\w*|orization\w*|enticate\w*)|session\w*)\s*(?:\(|=>)/i.test(
              stripRegexLiterals(body),
            ) ||
            registersAuthMiddleware(body)) {
          return {
            outcome: 'block',
            reason: 'auth/session/security logic requires human review',
            evidence: `changed diff line ${i + 1} contains code-shaped sensitive logic`,
          };
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

  return [
    testsNotGreen,
    protectedPaths,
    uninspectableBinary,
    secretsInDiff,
    sensitiveContent,
    newDependencies,
    diffTooLarge,
  ];
}
