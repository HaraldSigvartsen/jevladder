import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

const ALLOWLIST = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^CHANGELOG\.md$/,
  /^docs\/SECURITY\.md$/,
  /^dist\/src\/.+\.(js|d\.ts)$/,
  /^plugin\/.+/,
];

const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'docs/SECURITY.md',
  'dist/src/cli.js',
  'dist/src/index.js',
  'dist/src/index.d.ts',
  'plugin/.mcp.json',
  'plugin/scripts/jevladder-mcp.mjs',
  'plugin/cursor/.cursor/mcp.json',
  'plugin/opencode/jevladder.mjs',
  'plugin/zcode/mcp-servers.json',
];

const DENYLIST: RegExp[] = [
  /(^|\/)test\//,
  /(^|\/)eval\//,
  /(^|\/)examples\//,
  /node_modules\//,
  /\.map$/,
  /(^|\/)\.env/,
  /\.(pem|key|p12)$/,
  /(^|\/)(agent|notes|plan|private)\//i,
  /HANDOFF\.md|DECISIONS\.md|PLAN\.md/i,
  /docs\/assets\//,
  /\.tape$/,
  /\.gif$/,
  /\.test\.(js|ts)$/,
  /\.tsbuildinfo$/,
];

function buildSecretPatterns(): RegExp[] {
  const sk = ['s', 'k-'].join('');
  const openAiKey = new RegExp(sk + '[A-Za-z0-9_-]{20,}');
  const gh = ['ghp_', 'gho_', 'ghs_', 'github_pat_'].join('|');
  const githubToken = new RegExp(`(?:${gh})[A-Za-z0-9_]+`);
  const awsKey = new RegExp('AKIA' + '[A-Z0-9]{16}');
  const slack = new RegExp('xox' + '[abprs]' + '-' + '[A-Za-z0-9-]+');
  const privateKey = new RegExp('BEGIN [A-Z ]+PRIVATE KEY');
  return [openAiKey, githubToken, awsKey, slack, privateKey];
}

function buildLocalPathPatterns(): RegExp[] {
  const winUsers = ['[A-Z]:', '\\\\', 'Users', '\\\\'].join('');
  return [
    /\/Users\/[A-Za-z]/,
    /\/home\/[a-z][a-z0-9_-]*\//,
    new RegExp(winUsers),
  ];
}

function runPackDryRun(): { paths: string[]; unpackedSize: number } {
  const raw = execFileSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const [entry] = JSON.parse(raw) as Array<{
    files: Array<{ path: string }>;
    unpackedSize: number;
  }>;
  return {
    paths: entry.files.map((f) => f.path),
    unpackedSize: entry.unpackedSize,
  };
}

function distJsToSrcTs(distJsPath: string): string {
  return distJsPath.replace(/^dist\/src\//, 'src/').replace(/\.js$/, '.ts');
}

describe('npm package contents', () => {
  it('allowlists tarball paths and blocks leaks', { timeout: 120_000 }, () => {
    if (!existsSync(resolve(root, 'dist/src/cli.js'))) {
      execFileSync('pnpm', ['exec', 'tsc'], { cwd: root, stdio: 'inherit' });
    }

    const { paths, unpackedSize } = runPackDryRun();
    const pathSet = new Set(paths);

    for (const p of paths) {
      const allowed = ALLOWLIST.some((re) => re.test(p));
      expect(allowed, `unexpected tarball path: ${p}`).toBe(true);
      for (const deny of DENYLIST) {
        expect(deny.test(p), `denylisted path shipped: ${p} (${deny})`).toBe(false);
      }
    }

    for (const required of REQUIRED) {
      expect(pathSet.has(required), `missing required path: ${required}`).toBe(true);
    }

    const distJsPaths = paths.filter((p) => /^dist\/src\/.+\.js$/.test(p));
    for (const jsPath of distJsPaths) {
      const srcTs = distJsToSrcTs(jsPath);
      expect(
        existsSync(resolve(root, srcTs)),
        `stale dist artifact without src: ${jsPath} (expected ${srcTs})`,
      ).toBe(true);
    }

    const secretPatterns = buildSecretPatterns();
    const localPathPatterns = buildLocalPathPatterns();

    for (const relPath of paths) {
      if (relPath.endsWith('.png')) continue;
      const abs = resolve(root, relPath);
      let text: string;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      for (const local of localPathPatterns) {
        expect(local.test(text), `local path in ${relPath}`).toBe(false);
      }
      for (const secret of secretPatterns) {
        expect(secret.test(text), `secret-shaped string in ${relPath}`).toBe(false);
      }
    }

    expect(unpackedSize).toBeLessThan(600 * 1024);
  });
});
