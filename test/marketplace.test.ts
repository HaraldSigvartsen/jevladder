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

    expect(marketplace.name).toBe('jev');
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].name).toBe('jev');
    expect(marketplace.plugins[0].source).toBe('./plugin');
    expect(marketplace.plugins[0].version).toBe('0.3.0');
    expect(marketplace.plugins[0].author.name).toBeTruthy();
    expect(plugin.name).toBe(marketplace.plugins[0].name);
    expect(plugin.version).toBe('0.3.0');
  });
});
