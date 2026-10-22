import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCursorHostFiles,
  buildPluginFiles,
  CURSOR_BUNDLED_MCP_REL,
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

/** Paths from Cursor mcp.json args, relative to the generated output root. */
function workspaceRelativeMcpPaths(mcpJson: string): string[] {
  const mcp = JSON.parse(mcpJson) as { mcpServers: Record<string, { args?: string[] }> };
  const paths: string[] = [];
  for (const server of Object.values(mcp.mcpServers)) {
    for (const arg of server.args ?? []) {
      if (typeof arg !== 'string') continue;
      const rel = arg.replace(/^\$\{workspaceFolder\}\//, '');
      if (rel !== arg) paths.push(rel);
    }
  }
  return paths;
}

describe('Cursor host adapter', () => {
  it('emits valid MCP JSON and rule frontmatter without secrets or absolute paths', () => {
    const files = buildCursorHostFiles();
    const mcp = JSON.parse(files['.cursor/mcp.json'] as string) as {
      mcpServers: { jevladder: { command: string; args: string[] } };
    };
    expect(mcp.mcpServers.jevladder.command).toBe('node');
    expect(mcp.mcpServers.jevladder.args).toEqual([
      `\${workspaceFolder}/${CURSOR_BUNDLED_MCP_REL}`,
    ]);
    expect(JSON.stringify(mcp)).not.toMatch(/sk-|ghp_|api[_-]?key/i);
    expect(JSON.stringify(mcp)).not.toMatch(/^\/Users\//);

    const rule = files['.cursor/rules/jevladder.mdc'] as string;
    expect(rule).toMatch(/^---\ndescription: .+\nalwaysApply: true\n---\n/);
    expect(rule).toContain('cheap');
    expect(rule).toContain('jevladder_route');
    expect(rule).toContain('never swapped');
    expect(rule).not.toMatch(/\/Users\//);
  });

  it('bundles the shared MCP server and references only paths inside the output tree', () => {
    const files = buildCursorHostFiles();
    const shared = buildPluginFiles()['scripts/jevladder-mcp.mjs'];
    expect(files[CURSOR_BUNDLED_MCP_REL]).toBe(shared);

    for (const rel of workspaceRelativeMcpPaths(files['.cursor/mcp.json'] as string)) {
      expect(files[rel], `missing bundled file for mcp.json path ${rel}`).toBeDefined();
    }
  });

  it('is bundled under cursor/ in buildPluginFiles', () => {
    const files = buildPluginFiles();
    const nested = buildCursorHostFiles();
    expect(files['cursor/.cursor/mcp.json']).toBe(nested['.cursor/mcp.json']);
    expect(files['cursor/.cursor/rules/jevladder.mdc']).toBe(nested['.cursor/rules/jevladder.mdc']);
    expect(files[`cursor/${CURSOR_BUNDLED_MCP_REL}`]).toBe(nested[CURSOR_BUNDLED_MCP_REL]);
  });

  it('matches the checked-in repository .cursor files', () => {
    const root = resolve(import.meta.dirname, '..');
    const generated = buildCursorHostFiles();
    expect(readFileSync(join(root, '.cursor/mcp.json'), 'utf8')).toBe(generated['.cursor/mcp.json']);
    expect(readFileSync(join(root, '.cursor/rules/jevladder.mdc'), 'utf8')).toBe(
      generated['.cursor/rules/jevladder.mdc'],
    );
    expect(readFileSync(join(root, CURSOR_BUNDLED_MCP_REL), 'utf8')).toBe(
      generated[CURSOR_BUNDLED_MCP_REL],
    );
  });

  it('leaves Codex, Claude, and OpenCode plugin outputs unchanged', () => {
    const before = readFileSync(resolve('plugin/opencode/jevladder.mjs'), 'utf8');
    const files = buildPluginFiles();
    expect(files['opencode/jevladder.mjs']).toBe(before);
    expect(files['.mcp.json']).toBe(readFileSync(resolve('plugin/.mcp.json'), 'utf8'));
    expect(files['hooks/hooks.json']).toBe(readFileSync(resolve('plugin/hooks/hooks.json'), 'utf8'));
    expect(files['.claude-plugin/plugin.json']).toBe(
      readFileSync(resolve('plugin/.claude-plugin/plugin.json'), 'utf8'),
    );
  });

  it('CLI --host cursor writes project files under --out', async () => {
    const dir = tempDir('jevladder-cursor-cli-');
    let out = '';
    const io: CliIO = { stdout: (text) => { out += text; }, stderr: () => {} };
    expect(await runCli(['plugin', '--host', 'cursor', '--out', dir], io)).toBe(0);
    expect(readFileSync(join(dir, '.cursor/mcp.json'), 'utf8')).toContain('jevladder-mcp.mjs');
    expect(existsSync(join(dir, CURSOR_BUNDLED_MCP_REL))).toBe(true);
    expect(out).toContain(join(dir, '.cursor', 'mcp.json'));
  });
});
