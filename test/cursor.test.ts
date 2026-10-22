import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCursorHostFiles, buildPluginFiles, DEFAULT_CURSOR_PLUGIN_DIR } from '../src/plugin.js';
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

describe('Cursor host adapter', () => {
  it('emits valid MCP JSON and rule frontmatter without secrets or absolute paths', () => {
    const files = buildCursorHostFiles();
    const mcp = JSON.parse(files['.cursor/mcp.json'] as string) as {
      mcpServers: { jevladder: { command: string; args: string[] } };
    };
    expect(mcp.mcpServers.jevladder.command).toBe('node');
    expect(mcp.mcpServers.jevladder.args).toEqual([
      `\${workspaceFolder}/${DEFAULT_CURSOR_PLUGIN_DIR}/scripts/jevladder-mcp.mjs`,
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

  it('is bundled under cursor/ in buildPluginFiles', () => {
    const files = buildPluginFiles();
    const nested = buildCursorHostFiles();
    expect(files['cursor/.cursor/mcp.json']).toBe(nested['.cursor/mcp.json']);
    expect(files['cursor/.cursor/rules/jevladder.mdc']).toBe(nested['.cursor/rules/jevladder.mdc']);
  });

  it('matches the checked-in repository .cursor files', () => {
    const root = resolve(import.meta.dirname, '..');
    const generated = buildCursorHostFiles();
    expect(readFileSync(join(root, '.cursor/mcp.json'), 'utf8')).toBe(generated['.cursor/mcp.json']);
    expect(readFileSync(join(root, '.cursor/rules/jevladder.mdc'), 'utf8')).toBe(
      generated['.cursor/rules/jevladder.mdc'],
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
    expect(out).toContain(join(dir, '.cursor', 'mcp.json'));
  });
});
