import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPluginFiles, writePluginFiles } from '../src/plugin.js';

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

/** macOS may expose temp dirs as `/private/var/...` via `import.meta.url`. */
function pluginSkillsDir(pluginOutDir: string): string {
  return realpathSync(join(pluginOutDir, 'skills'));
}

function pluginMcpScript(pluginOutDir: string): string {
  return realpathSync(join(pluginOutDir, 'scripts', 'jevladder-mcp.mjs'));
}

async function loadPlugin(dir: string) {
  const href = pathToFileURL(join(dir, 'opencode', 'jevladder.mjs')).href;
  const mod = await import(href);
  expect(Object.keys(mod)).toEqual(['JevLadderPlugin']);
  const hooks = await mod.JevLadderPlugin({ directory: '/tmp/proj' });
  expect(hooks).not.toHaveProperty('permission.ask');
  return hooks as Record<string, (input?: unknown, output?: unknown) => Promise<void>>;
}

describe('OpenCode adapter', () => {
  it('is emitted without a permission denial or a tool-arg rewrite', () => {
    const source = buildPluginFiles()['opencode/jevladder.mjs'] as string;
    expect(source).toContain('export const JevLadderPlugin');
    expect(source).not.toContain('export default');
    expect(source).not.toContain('permission.ask');
    expect(source).not.toContain('permissionDecision');
    expect(source).toContain('Do not rewrite args');
  });

  it('the repository loader re-exports the generated plugin once', () => {
    const loader = readFileSync(join(import.meta.dirname, '..', '.opencode/plugins/jevladder.mjs'), 'utf8');
    expect(loader).toContain("export { JevLadderPlugin } from '../../plugin/opencode/jevladder.mjs'");
    expect(loader).not.toContain('export default');
  });

  it('adds MCP and skills without replacing existing config', async () => {
    const dir = tempDir('jevladder-opencode-');
    writePluginFiles(dir);
    const hooks = await loadPlugin(dir);
    const config: {
      mcp: { servers: Record<string, { type: string; command: string[] }> };
      skills: string[];
    } = {
      mcp: { servers: { other: { type: 'local', command: ['echo'] }, jevladder: { type: 'local', command: ['custom'] } } },
      skills: ['./keep'],
    };
    await hooks.config(config);
    expect(config.mcp.servers.other.command).toEqual(['echo']);
    expect(config.mcp.servers.jevladder.command).toEqual(['custom']);
    expect(config.skills).toContain('./keep');
    expect(config.skills).toContain(pluginSkillsDir(dir));
    const before = config.skills.length;
    await hooks.config(config);
    expect(config.skills).toHaveLength(before);

    const fresh: { mcp?: { servers?: Record<string, { command: string[] }> }; skills?: string[] } = {};
    await hooks.config(fresh);
    expect(fresh.mcp?.servers?.jevladder.command[0]).toBe('node');
    expect(fresh.mcp?.servers?.jevladder.command[1]).toBe(pluginMcpScript(dir));
    expect(fresh.skills).toEqual([pluginSkillsDir(dir)]);
    await hooks.config(null);
    const legacy: { skills: { paths: string[] } } = { skills: { paths: ['./legacy'] } };
    await hooks.config(legacy);
    expect(legacy.skills.paths).toEqual(['./legacy', pluginSkillsDir(dir)]);
  });

  it('appends system guidance once and a privacy-safe route note', async () => {
    const dir = tempDir('jevladder-opencode-route-');
    writePluginFiles(dir);
    const hooks = await loadPlugin(dir);
    const log = join(dir, 'observe.jsonl');
    process.env.JEVLADDER_OBSERVE_LOG = log;
    try {
      const system = { system: ['existing guidance'] };
      await hooks['experimental.chat.system.transform']({}, system);
      await hooks['experimental.chat.system.transform']({}, system);
      expect(system.system[0]).toBe('existing guidance');
      expect(system.system.filter((line) => line.includes('advisory on OpenCode'))).toHaveLength(1);
      expect(system.system[1]).toContain('never blocks a tool call');

      const prompt = 'migrate payments in production and delete old table PRIVATE_PROMPT';
      const output = { parts: [{ type: 'text', text: prompt }] };
      await hooks['chat.message']({ sessionID: 'oc-1' }, output);
      await hooks['chat.message']({ sessionID: 'oc-1' }, output);
      expect(output.parts).toHaveLength(2);
      const note = output.parts[1] as { text: string };
      expect(note.text).toContain('tier=frontier');
      expect(note.text).toContain('Advisory only on OpenCode');
      expect(note.text).not.toContain('PRIVATE_PROMPT');
      const entry = JSON.parse(readFileSync(log, 'utf8').trim()) as {
        session_id: string;
        tier: string;
        promptChars: number;
      };
      expect(entry.session_id).toBe('oc-1');
      expect(entry.tier).toBe('frontier');
      expect(entry.promptChars).toBe(prompt.length);
      expect(readFileSync(log, 'utf8')).not.toContain('PRIVATE_PROMPT');
      expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      delete process.env.JEVLADDER_OBSERVE_LOG;
    }
  });

  it('annotates write and merge results without rewriting or echoing tool input', async () => {
    const dir = tempDir('jevladder-opencode-tool-');
    writePluginFiles(dir);
    const hooks = await loadPlugin(dir);
    const args = { command: 'git merge main # PRIVATE_MERGE', content: 'PRIVATE_FILE' };
    const before = { args };
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, before);
    expect(before.args).toBe(args);
    expect(args.command).toContain('PRIVATE_MERGE');

    const merge = { title: 'bash', output: 'merged', metadata: {} };
    await hooks['tool.execute.after']({ tool: 'bash', args }, merge);
    await hooks['tool.execute.after']({ tool: 'bash', args }, merge);
    expect(merge.output.startsWith('merged\n')).toBe(true);
    expect(merge.output).toContain('merge-like command');
    expect(merge.output).toContain('does not approve or deny');
    expect(merge.output).not.toContain('PRIVATE_MERGE');
    expect(merge.output.match(/jevladder observe: OpenCode/g)).toHaveLength(1);

    const edit = { title: 'edit', output: 'done', metadata: {} };
    await hooks['tool.execute.after']({ tool: 'edit', args: { content: 'PRIVATE_FILE' } }, edit);
    expect(edit.output).toContain('file write');
    expect(edit.output).not.toContain('PRIVATE_FILE');

    const quiet = { title: 'bash', output: 'ok', metadata: {} };
    await hooks['tool.execute.after']({ tool: 'bash', args: { command: 'git status' } }, quiet);
    expect(quiet.output).toBe('ok');
    const read = { title: 'read', output: 'file', metadata: {} };
    await hooks['tool.execute.after']({ tool: 'read', args: { filePath: 'SECRET_PATH' } }, read);
    expect(read.output).toBe('file');

    await hooks['tool.execute.after'](null, null);
    await hooks['chat.message'](null, null);
    await hooks['experimental.chat.system.transform'](null, { system: 'not-an-array' });
  });
});
