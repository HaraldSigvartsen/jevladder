import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Claude Code marketplace metadata', () => {
  it('points at the checked-in plugin and keeps names and versions aligned', () => {
    const root = resolve(import.meta.dirname, '..');
    const marketplace = JSON.parse(
      readFileSync(resolve(root, '.claude-plugin/marketplace.json'), 'utf8'),
    );
    const plugin = JSON.parse(
      readFileSync(resolve(root, 'plugin/.claude-plugin/plugin.json'), 'utf8'),
    );

    expect(marketplace.name).toBe('tierclef');
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].name).toBe('tierclef');
    expect(marketplace.plugins[0].source).toBe('./plugin');
    expect(marketplace.plugins[0].version).toBe('0.6.0');
    expect(marketplace.plugins[0].author.name).toBeTruthy();
    expect(plugin.name).toBe(marketplace.plugins[0].name);
    expect(plugin.version).toBe('0.6.0');
  });
});

describe('Codex marketplace metadata', () => {
  const root = resolve(import.meta.dirname, '..');
  const readJson = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));

  it('places a valid catalog at the Codex discovery path', () => {
    const marketplace = readJson('.agents/plugins/marketplace.json');
    expect(marketplace.name).toBe('tierclef');
    expect(marketplace.interface.displayName).toBe('TierClef');
    expect(marketplace.plugins).toEqual([{
      name: 'tierclef', source: { source: 'local', path: './plugin' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Developer Tools',
    }]);
  });

  it('keeps the bundled manifest, MCP, and hooks aligned', () => {
    const plugin = readJson('plugin/.codex-plugin/plugin.json');
    const pkg = readJson('package.json');
    expect(plugin.name).toBe('tierclef');
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.skills).toBe('./skills/');
    expect(plugin.hooks).toBe('./hooks/hooks.json');
    expect(plugin.mcpServers).toBe('./.mcp.json');
    expect(plugin.interface.capabilities).toEqual(['Instructions', 'Lifecycle hooks']);
    expect(plugin.interface.defaultPrompt.length).toBeGreaterThanOrEqual(2);
    expect(plugin.interface.defaultPrompt.length).toBeLessThanOrEqual(3);
    expect(plugin).not.toHaveProperty('icon');
    expect(plugin).not.toHaveProperty('logo');
    const mcp = readJson(`plugin/${plugin.mcpServers}`);
    expect(mcp).toEqual({ mcpServers: { tierclef: { command: 'node', args: ['./scripts/tierclef-mcp.mjs'], cwd: '.' } } });
    expect(readFileSync(resolve(root, 'plugin', mcp.mcpServers.tierclef.args[0]), 'utf8')).toContain('MAX_LINE_BYTES');
    expect(readJson(`plugin/${plugin.hooks}`).hooks.SessionStart).toBeTruthy();
  });
});
