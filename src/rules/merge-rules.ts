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
 * Word parts of an identifier across camelCase, snake_case, SCREAMING_SNAKE,
 * and dotted chains (`session.ttl`). `oauthDocs` stays `oauth` + `docs` —
 * `auth` is not a part. `author` / `authority` stay one word.
 */
function identifierWordParts(identifier: string): string[] {
  const splitCamel = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return splitCamel
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part !== '')
    .map((part) => part.toLowerCase());
}

/** Auth-family words. `author` and `authority` are not in this set; `oauth` is not `auth`. */
const AUTH_FAMILY_WORD_RE =
  /^(?:csrf|auth|authn|authz|authenticates?|authenticated|authentication|authorizes?|authorized|authorization|authorises?|authorised|authorisation)$/;

/**
 * Extra words that keep a `session…` binding a label or the browser storage
 * API rather than session logic: `sessionName`, `sessionStorage`.
 * `sessionStorage` UI reads (`sessionStorage.setItem(...)`) are not
 * declarations and are not lifetime identifiers, so they do not block.
 * A lifetime word still blocks (`sessionStorageTtl`, `SESSION_TTL_SECONDS`).
 */
const SESSION_LABEL_WORD_RE =
  /^(?:name|names|label|labels|title|titles|text|copy|message|description|note|notes|color|colour|theme|style|draft|storage)$/;

const LIFETIME_WORD_RE = /^(?:ttl|expires?|expiry|expiration|lifetime|maxage|timeouts?)$/;

function hasLifetimeWord(parts: readonly string[]): boolean {
  if (parts.some((part) => LIFETIME_WORD_RE.test(part))) return true;
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'max' && parts[i + 1] === 'age') return true;
  }
  return false;
}

/**
 * Session-family word parts. The plural `sessions` counts like `session`,
 * so `sessionsTtl` and `SESSIONS_TTL_SECONDS` cannot dodge the checks by
 * spelling the word in the plural.
 */
function isSessionWordPart(part: string): boolean {
  return part === 'session' || part === 'sessions';
}

/** Token-family word parts; the plural `tokens` counts like `token`. */
function isTokenWordPart(part: string): boolean {
  return part === 'token' || part === 'tokens';
}

/** True when one identifier or dotted chain names a session/token lifetime. */
function hasSessionOrTokenLifetime(code: string): boolean {
  const chainRe = /[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/g;
  for (const match of code.matchAll(chainRe)) {
    const parts = identifierWordParts(match[0]);
    if (!parts.some((part) => isSessionWordPart(part) || isTokenWordPart(part))) continue;
    if (hasLifetimeWord(parts)) return true;
  }
  return false;
}

/**
 * Plural note: `sessions` counts like `session` here too, BUT a bare plural
 * binding (`const sessions = useAnalytics()`, `const tokens = design(theme)`)
 * stays allowed — the bare plural is a common analytics/UI word, while the
 * bare singular (`const session = load()`) names session logic. Combined
 * with any non-label part (`sessionsTtl`, `SessionsGuard`) the plural counts.
 * `token`/`tokens` parts stay in `others` as non-label words, so a label word
 * cannot exempt a session-token name (`sessionTokenName`, `sessionNameToken`).
 */
function isSensitiveDeclarationName(name: string): boolean {
  const parts = identifierWordParts(name);
  if (parts.some((part) => AUTH_FAMILY_WORD_RE.test(part))) return true;
  const sessionParts = parts.filter(isSessionWordPart);
  if (sessionParts.length === 0) return false;
  const others = parts.filter((part) => !isSessionWordPart(part));
  if (others.length === 0) return sessionParts.includes('session');
  if (others.every((part) => SESSION_LABEL_WORD_RE.test(part))) return false;
  return true;
}

function declaredNames(code: string): string[] {
  const declRe =
    /(?:^|[^\w$])(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?\s+|const\s+|let\s+|var\s+|class\s+|interface\s+|type\s+|enum\s+)([A-Za-z_$][\w$]*)/g;
  const names: string[] = [];
  for (const match of code.matchAll(declRe)) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

function lineDeclaresSensitiveName(code: string): boolean {
  return declaredNames(code).some((name) => isSensitiveDeclarationName(name));
}

/**
 * A full-line comment: `//`, a `#` comment, a single-line block comment that
 * closes on the same line, a bare closing star-slash line, or a JSDoc
 * continuation line starting with `*` followed by a space or tab.
 * `#` counts as a comment only when the `#` is followed by whitespace, `!`
 * (shebang), or end of line — a JS/TS private field such as
 * `#sessionTtl = 3600` is code, is not skipped here, and is scanned.
 * Block-comment state is NOT tracked across lines: a continuation line of a
 * multi-line block comment that does not have one of these shapes (no
 * leading star, or `*WORD` with no space after the star) is scanned like
 * code and may still block — the safe direction.
 * A line that still has code after the comment is not comment-only; later
 * checks see that code.
 */
function isCommentOnlyBody(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed === '') return true;
  if (trimmed.startsWith('//')) return true;
  if (trimmed.startsWith('#')) {
    const next = trimmed[1];
    return next === undefined || next === ' ' || next === '\t' || next === '!';
  }
  if (trimmed.startsWith('/*')) {
    const close = trimmed.indexOf('*/');
    if (close === -1) return true;
    return trimmed.slice(close + 2).trim() === '';
  }
  if (trimmed.startsWith('*/') && trimmed.slice(2).trim() === '') return true;
  if (trimmed.startsWith('*') && (trimmed.length === 1 || trimmed[1] === ' ' || trimmed[1] === '\t')) {
    return true;
  }
  return false;
}

interface SensitiveDeclScope {
  depth: number;
  /** Brace depth of the open auth/session/csrf declaration body, if any. */
  bodyDepth: number | null;
  pendingBrace: boolean;
}

function freshSensitiveDeclScope(): SensitiveDeclScope {
  return { depth: 0, bodyDepth: null, pendingBrace: false };
}

/**
 * Track a declaration body that is visible in this hunk. A field or statement
 * edit inside an auth, session, or csrf declaration still counts when the
 * header is hunk context. Resets at each diff header and hunk marker because
 * a later hunk does not repeat braces.
 */
function updateSensitiveDeclScope(scope: SensitiveDeclScope, code: string, opensSensitive: boolean): void {
  const braceOnly = code.trim().replace(/[{} \t]/g, '') === '';
  if (declaredNames(code).length > 0) {
    scope.pendingBrace = opensSensitive && !code.includes('{');
  }
  for (const ch of code) {
    if (ch === '{') {
      scope.depth++;
      // A `{` on its own line can continue `interface AuthUser` / `class CsrfGuard`.
      // Any other `{` (for example `if (ready) {`) must not inherit that header.
      const adopts = opensSensitive || (scope.pendingBrace && braceOnly);
      if (scope.bodyDepth === null && adopts) {
        scope.bodyDepth = scope.depth;
        scope.pendingBrace = false;
      }
    } else if (ch === '}') {
      scope.depth = Math.max(0, scope.depth - 1);
      if (scope.bodyDepth !== null && scope.depth < scope.bodyDepth) scope.bodyDepth = null;
    }
  }
  if (!opensSensitive && !braceOnly && code.trim() !== '') scope.pendingBrace = false;
}

/**
 * Scan `source[start, end)` with the same string/comment awareness used for
 * argument extraction, and return the surviving code text:
 * - string-literal contents (single/double quotes) are stripped,
 * - `//` and `/* *​/` comment contents are stripped,
 * - template-literal TEXT is stripped, while `${...}` interpolation
 *   expressions are RECURSIVELY scanned with this same function, so nested
 *   templates, nested strings, comments, and regex literals inside
 *   interpolations are handled identically to top-level code. The closing
 *   `}` of each interpolation is located by {@link findInterpolationEnd}.
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
      if (i < end) i++;
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
          const j = findInterpolationEnd(source, i + 2, end);
          out += ' ' + scanCodeRegion(source, i + 2, j);
          i = j + 1;
          continue;
        }
        i++;
      }
      if (i < end && source[i] === '`') i++;
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
 * Index of the `}` that closes a `${...}` interpolation whose body starts at
 * `start` (the first character after `${`). Returns `end` when the
 * interpolation is unterminated (`end` defaults to `body.length`).
 *
 * `{` and `}` inside single/double-quoted strings, `//` and block comments,
 * regex literals, and nested template literals do not affect the depth.
 * Nested template `${...}` expressions are measured with this same function.
 * A `/` starts a regex only when {@link regexCanStartAfter} allows it, and
 * the literal must close on the same line with `[...]` classes and `\`
 * escapes respected; otherwise the `/` is ordinary code. If that scan never
 * finds a closer, a raw brace count is used so an unterminated regex cannot
 * swallow the rest of the call.
 */
function findInterpolationEnd(body: string, start: number, end = body.length): number {
  function findAware(): number {
    /** Index just past a quoted string that opens at `from`, or `end` if unterminated. */
    const endOfString = (from: number): number => {
      const quote = body[from];
      let i = from + 1;
      while (i < end) {
        if (body[i] === '\\') {
          i += 2;
          continue;
        }
        if (body[i] === quote) return i + 1;
        i++;
      }
      return end;
    };

    /**
     * Index just past a template literal that opens at `from`. Braces in its
     * static text are ignored; nested `${...}` interpolations are measured
     * recursively. Strings inside the template are skipped so a `${` in quotes
     * is not an interpolation.
     */
    const endOfTemplate = (from: number): number => {
      let i = from + 1;
      while (i < end && body[i] !== '`') {
        if (body[i] === '\\') {
          i += 2;
          continue;
        }
        if (body[i] === '"' || body[i] === "'") {
          i = endOfString(i);
          continue;
        }
        if (body[i] === '$' && body[i + 1] === '{') {
          const close = findInterpolationEnd(body, i + 2, end);
          i = close < end ? close + 1 : end;
          continue;
        }
        i++;
      }
      return i < end ? i + 1 : end;
    };

    let depth = 1;
    let prev = '';
    let i = start;
    while (i < end && depth > 0) {
      const ch = body[i];
      if (ch === '/' && body[i + 1] === '/') {
        while (i < end && body[i] !== '\n') i++;
        prev = '/';
        continue;
      }
      if (ch === '/' && body[i + 1] === '*') {
        i += 2;
        while (i < end && !(body[i] === '*' && body[i + 1] === '/')) i++;
        if (i < end) i += 2;
        prev = '/';
        continue;
      }
      if (ch === '"' || ch === "'") {
        i = endOfString(i);
        prev = ch;
        continue;
      }
      if (ch === '`') {
        i = endOfTemplate(i);
        prev = '`';
        continue;
      }
      if (ch === '/' && body[i + 1] !== '/' && body[i + 1] !== '*' && regexCanStartAfter(prev)) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < end) {
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
          i = j + 1;
          while (i < end && /[A-Za-z]/.test(body[i])) i++;
          prev = '/';
          continue;
        }
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
      prev = ch;
      i++;
    }
    return i > end ? end : i;
  }
  const aware = findAware();
  if (aware < end && body[aware] === '}') return aware;
  // The aware scan found no closer (for example an unterminated regex whose
  // backtick looks like a nested template). Raw brace depth still closes on a
  // later `}` so that text stays inside the interpolation and can match.
  let depth = 1;
  for (let i = start; i < end; i++) {
    const ch = body[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return end;
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
          const k = findInterpolationEnd(body, j + 2);
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
          const j = findInterpolationEnd(body, i + 2);
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

  function lineHasLegacySensitiveOperation(body: string): boolean {
    return (
      /(?:session|token)\s*(?:\.\s*)?(?:expires?|expiry|expiration|lifetime|maxage|ttl)\s*(?:[:=]|\+=|-=)/i.test(body) ||
      /(?:maxage|ttl)\s*[:=][^\n]*(?:session|token)/i.test(body) ||
      /\b(?:jwt|jsonwebtoken)\s*\.\s*(?:sign|verify)\s*\(/i.test(body) ||
      isStandaloneSignVerifyWithJwtToken(body) ||
      /(?:password|passwd)[^\n]*(?:hash|compare|verify)\s*\(|(?:hash|compare|verify)\s*\([^\n]*(?:password|passwd)/i.test(body) ||
      /\b(?:hasPermission|canAccess|authorize|isAuthorized|checkPermission|requireRole|hasRole)\s*\(/i.test(body) ||
      /\b(?:csrf\w*|auth(?:\b|entication\w*|orization\w*|enticate\w*)|session\w*|requireAuth)\s*(?:\(|=>)/i.test(
        stripRegexLiterals(body),
      ) ||
      registersAuthMiddleware(body)
    );
  }

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
      let declScope = freshSensitiveDeclScope();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        if (line.startsWith('diff --git ') || line.startsWith('@@')) {
          if (line.startsWith('diff --git ')) {
            const parsed = parseGitDiffHeader(line);
            oldFile = parsed?.oldPath;
            newFile = parsed?.newPath;
          }
          declScope = freshSensitiveDeclScope();
          continue;
        }
        const added = isAddedDiffLine(line);
        const removed = isRemovedDiffLine(line);
        const context = line.startsWith(' ');
        if (!added && !removed && !context) continue;
        const body = line.slice(1);
        const changedFile = added ? newFile : removed ? oldFile : newFile === '/dev/null' ? oldFile : (newFile ?? oldFile);
        if (changedFile?.toLowerCase().endsWith('.md')) continue;
        if (isCommentOnlyBody(body)) continue;
        const code = scanCodeRegion(body, 0, body.length);
        const opensSensitive = lineDeclaresSensitiveName(code);
        const inSensitiveBody = declScope.bodyDepth !== null && declScope.depth >= declScope.bodyDepth;
        const changed = added || removed;
        if (
          changed &&
          (lineHasLegacySensitiveOperation(body) ||
            (/[A-Za-z0-9]/.test(code) &&
              (opensSensitive || hasSessionOrTokenLifetime(code) || inSensitiveBody)))
        ) {
          return {
            outcome: 'block',
            reason: 'auth/session/security logic requires human review',
            evidence: `changed diff line ${i + 1} contains code-shaped sensitive logic`,
          };
        }
        updateSensitiveDeclScope(declScope, code, opensSensitive);
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
