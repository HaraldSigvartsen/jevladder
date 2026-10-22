import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPluginFiles,
  buildZcodeHostFiles,
  jevladderRoutingGuidance,
  ZCODE_BUNDLED_MCP_REL,
  writeZcodeHostFiles,
} from '../src/plugin.js';
import { runCli } from '../src/cli.js';
import type { CliIO } from '../src/cli.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('ZCode host adapter', () => {
  it('emits valid MCP fragment and guidance without secrets or env values', () => {
    const zcodeRoot = join(tempDir('jevladder-zcode-abs-'), 'zcode');
    const files = buildZcodeHostFiles(zcodeRoot);
    const mcp = JSON.parse(files['mcp-servers.json'] as string) as {
      mcp: { servers: { jevladder: { command: string; args: string[]; env?: Record<string, string> } } };
    };
    expect(mcp.mcp.servers.jevladder.command).toBe('node');
    expect(mcp.mcp.servers.jevladder.args).toEqual([join(zcodeRoot, ZCODE_BUNDLED_MCP_REL)]);
    expect(mcp.mcp.servers.jevladder.env).toBeUndefined();
    expect(JSON.stringify(mcp)).not.toMatch(/sk-|ghp_|api[_-]?key/i);

    const agents = files['AGENTS.jevladder.md'] as string;
    expect(agents).toBe(jevladderRoutingGuidance().endsWith('\n') ? jevladderRoutingGuidance() : `${jevladderRoutingGuidance()}\n`);
    expect(agents).toContain('cheap');
    expect(agents).toContain('jevladder_route');
    expect(agents).not.toMatch(/\/Users\//);
  });

  it('bundles the shared MCP server and references only paths inside the zcode tree', () => {
    const zcodeRoot = join(tempDir('jevladder-zcode-bundle-'), 'zcode');
    const files = buildZcodeHostFiles(zcodeRoot);
    const shared = buildPluginFiles()['scripts/jevladder-mcp.mjs'];
    expect(files[ZCODE_BUNDLED_MCP_REL]).toBe(shared);

    const mcp = JSON.parse(files['mcp-servers.json'] as string) as {
      mcp: { servers: { jevladder: { args: string[] } } };
    };
    const arg = mcp.mcp.servers.jevladder.args[0];
    expect(arg).toBe(join(zcodeRoot, ZCODE_BUNDLED_MCP_REL));
    expect(files[ZCODE_BUNDLED_MCP_REL]).toBeDefined();
  });

  it('uses a relative MCP path in the full-plugin template bundle', () => {
    const files = buildZcodeHostFiles();
    const mcp = JSON.parse(files['mcp-servers.json'] as string) as {
      mcp: { servers: { jevladder: { args: string[] } } };
    };
    expect(mcp.mcp.servers.jevladder.args).toEqual([`./${ZCODE_BUNDLED_MCP_REL}`]);
  });

  it('is bundled under zcode/ in buildPluginFiles', () => {
    const files = buildPluginFiles();
    const nested = buildZcodeHostFiles();
    expect(files['zcode/mcp-servers.json']).toBe(nested['mcp-servers.json']);
    expect(files['zcode/AGENTS.jevladder.md']).toBe(nested['AGENTS.jevladder.md']);
    expect(files[`zcode/${ZCODE_BUNDLED_MCP_REL}`]).toBe(nested[ZCODE_BUNDLED_MCP_REL]);
  });

  it('CLI --host zcode writes only under --out and never touches a fake HOME .zcode tree', async () => {
    const fakeHome = tempDir('jevladder-zcode-fake-home-');
    const out = tempDir('jevladder-zcode-cli-');
    const zcodeInHome = join(fakeHome, '.zcode');
    let stdout = '';
    const io: CliIO = { stdout: (text) => { stdout += text; }, stderr: () => {} };
    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    const code = await runCli(['plugin', '--host', 'zcode', '--out', out], io);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    expect(code).toBe(0);
    expect(existsSync(zcodeInHome)).toBe(false);
    expect(readFileSync(join(out, 'zcode', 'mcp-servers.json'), 'utf8')).toContain('jevladder-mcp.mjs');
    expect(existsSync(join(out, 'zcode', ZCODE_BUNDLED_MCP_REL))).toBe(true);
    const mcp = JSON.parse(readFileSync(join(out, 'zcode', 'mcp-servers.json'), 'utf8')) as {
      mcp: { servers: { jevladder: { args: string[] } } };
    };
    expect(mcp.mcp.servers.jevladder.args[0]).toBe(join(resolve(out), 'zcode', ZCODE_BUNDLED_MCP_REL));
    expect(stdout).toContain(join(out, 'zcode', 'mcp-servers.json'));
  });

  it('writeZcodeHostFiles keeps all paths under the resolved output directory', () => {
    const out = tempDir('jevladder-zcode-write-');
    const written = writeZcodeHostFiles(out);
    const absOut = resolve(out);
    for (const path of written) {
      expect(path.startsWith(absOut)).toBe(true);
    }
  });

  it('rejects unknown --host values', async () => {
    const { io } = { io: { stdout: () => {}, stderr: () => {} } as CliIO };
    expect(await runCli(['plugin', '--host', 'vscode', '--out', tempDir('jevladder-zcode-bad-host-')], io)).toBe(1);
  });
});
