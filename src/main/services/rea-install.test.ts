import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { McpConfigWriter } from '../pi/mcp-config';
import { checkRea, installRea } from './rea-install';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rea-install-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

it('merges REA alongside a concurrent Cocos bridge write and preserves disabled entries', async () => {
  const bridge = new McpConfigWriter();
  const rea = new McpConfigWriter('rea');
  await Promise.all([rea.addStdio({ command: 'node', args: ['rea.mjs', 'mcp'] }), bridge.write('local')]);
  expect(JSON.parse(await readFile(rea.configPath, 'utf8')).mcpServers).toHaveProperty('cocos');
  expect((await checkRea()).state).toBe('ready');
  const custom = JSON.stringify({ mcpServers: { rea: { disabled: true, command: 'custom' } } });
  await writeFile(rea.configPath, custom);
  await expect(installRea()).rejects.toThrow('disabled');
  expect(await readFile(rea.configPath, 'utf8')).toBe(custom);
});

it('reports malformed config and refuses to replace it', async () => {
  const rea = new McpConfigWriter('rea');
  await writeFile(rea.configPath, '{');
  expect((await checkRea()).state).toBe('error');
  await expect(rea.addStdio({ command: 'node', args: [] })).rejects.toThrow();
  expect(await readFile(rea.configPath, 'utf8')).toBe('{');
});

it.skipIf(!process.env.REA_INSTALL_SMOKE)('installs REA and verifies its real stdio tool before merging the entry', async () => {
  const bridge = new McpConfigWriter();
  await bridge.write('local');
  const file = await installRea();
  const { mcpServers } = JSON.parse(await readFile(file, 'utf8'));
  expect(mcpServers.cocos.url).toBe('local');
  expect(mcpServers.rea.args.at(-1)).toBe('mcp');
  expect((await checkRea()).state).toBe('ready');
}, 320_000);
