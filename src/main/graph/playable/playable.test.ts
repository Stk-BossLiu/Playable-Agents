import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLocalPlayableHtml, PLAYABLE_AGENT_TYPE, PLAYABLE_SYSTEM_PROMPT } from '../../../shared/playable';
import { inspectPlayable, readPlayable } from './html';
import { extractPlayable } from './extract';
import { ArtifactStore } from '../artifacts';
import { RunStore } from '../run-store';
import { inspectScripts } from './rea';
import { createNodeRegistry } from '../nodes';
import { playableNode } from './node';
import type { NodeRunContext } from '../nodes/types';

const path = resolve('resources/samples/card-choice.html');
let temp: string;
beforeEach(async () => { temp = await mkdtemp(join(tmpdir(), 'playable-test-')); vi.stubEnv('PI_CODING_AGENT_DIR', temp); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(temp, { recursive: true, force: true }); });
function context(): NodeRunContext {
  return { projectRoot: temp, runId: 'test', graph: { schemaVersion: 1, id: 'g', name: 'g', builtin: false, version: '1', nodes: [], edges: [] },
    node: { id: 'rea', type: playableNode.type, title: 'REA', position: { x: 0, y: 0 } }, params: { playMode: 'manual' }, inputs: { artifact: { path } },
    signal: new AbortController().signal, log: vi.fn(), stream: vi.fn(), tool: vi.fn(), human: vi.fn(),
    agent: async () => ({ text: JSON.stringify([{ topic: '玩法', text: '静态推断：点击推进波次', refs: ['C1'] }, { topic: '玩法', text: '无依据', refs: ['P999'] }]) }),
    writeArtifact: async item => { const target = join(temp, item.path); await writeFile(target, item.content); return { id: item.path, type: item.type, name: item.path, path: target }; },
  };
}
describe('HTML playable subgraph', () => {
  it('only accepts absolute local HTML paths', () => {
    for (const invalid of ['a.html', 'https://example.org/a.html', '//host/a.html', '/tmp/a.zip', 'file:///tmp/a.html']) expect(isLocalPlayableHtml(invalid)).toBe(false);
    expect(isLocalPlayableHtml(path.toUpperCase())).toBe(true);
  });
  it('locates references, inline code and source offsets without executing scripts', async () => {
    const { html } = await readPlayable(path);
    const { assets, clues, scripts } = inspectPlayable(html);
    expect(assets[0].kind).toBe('image/svg+xml'); expect(scripts).toHaveLength(1);
    expect(clues.some(c => html.startsWith('gameEnd', c.offset))).toBe(true);
  });
  it('rejects a renamed non-HTML file', async () => {
    const fake = join(temp, 'fake.html'); await writeFile(fake, 'plain text'); await expect(readPlayable(fake)).rejects.toThrow('HTML');
  });
  it('persists usable evidence on missing REA and excludes unknown references', async () => {
    const result = await playableNode.run(context());
    expect(result.outputs?.json).toMatchObject({ status: 'partial', available: true, inlineScripts: 1 });
    expect(result.artifacts).toHaveLength(3);
    const report = await readFile(join(temp, 'playable-analysis.md'), 'utf8');
    expect(report).toContain('点击推进波次'); expect(report).not.toContain('P999'); expect(report).toContain('mcpServers.rea');
  });
  it('saves static dependencies and routes new documents to the previewable docs tree', async () => {
    const htmlPath = join(temp, 'reference.html');
    const js = 'throw Error("target script executed");';
    await writeFile(join(temp, 'game.js'), js);
    await writeFile(htmlPath, '<style>b{background:url(data:image/png;base64,AP8=)}</style><script src="game.js"></script><img src="../outside.png"><img src="https://example.org/img.png">');
    const ctx = context();
    const store = new ArtifactStore(temp, 'g');
    ctx.writeArtifact = input => store.write('test', 'rea', input);
    ctx.inputs = { artifact: { path: htmlPath } };
    const result = await playableNode.run(ctx);
    expect(ctx.human).not.toHaveBeenCalled();
    const docs = join(temp, 'docs', 'cocos-ai-agent', 'g', 'test', 'rea');
    expect(result.artifacts?.map(a => a.path)).toEqual(['assets.json','evidence.json','playable-analysis.md'].map(name => join(docs, name)));
    const preview = new RunStore(temp);
    const evidence = JSON.parse((await preview.readArtifact(join(docs, 'evidence.json'))).content);
    expect(evidence.directory.startsWith(join(temp, 'playable-analyse') + sep)).toBe(true);
    expect(await readFile(join(evidence.directory, 'scripts', evidence.reaSources[0]), 'utf8')).toBe(js);
    const { assets } = JSON.parse((await preview.readArtifact(join(docs, 'assets.json'))).content);
    expect(await readFile(join(evidence.directory, assets[0].path))).toEqual(Buffer.from([0,255]));
    expect(assets.slice(-2).every((a: { reason?: string }) => a.reason)).toBe(true);
    await expect(preview.readArtifact(htmlPath)).rejects.toThrow();
    await expect(store.write('test', 'rea', { type: 'markdown', path: '../outside.md', content: '' })).rejects.toThrow();
  });
  it('uses the same reverse analyst and node overrides for both graph entry points', async () => {
    const ctx = context();
    const agent = vi.fn(ctx.agent);
    ctx.agent = agent;
    Object.assign(ctx.params, { provider: 'profile-company', model: 'test-model', prompt: '关注反馈' });
    await playableNode.run(ctx);
    const standalone = createNodeRegistry().get(PLAYABLE_AGENT_TYPE);
    expect(standalone).toBeDefined();
    ctx.inputs = { evidence: { clues: [{ id: 'C1', label: '玩家输入' }] } };
    const output = await standalone!.run(ctx);
    expect(output.outputs?.json).toHaveLength(1);
    expect(agent).toHaveBeenCalledTimes(2);
    for (const [request] of agent.mock.calls) {
      expect(request).toMatchObject({ provider: 'profile-company', model: 'test-model', systemPrompt: PLAYABLE_SYSTEM_PROMPT });
      expect(JSON.parse(request.prompt)).toMatchObject({ focus: '关注反馈' });
    }
  });
  it('skips an unconnected input', async () => {
    const ctx = context(); ctx.inputs = {}; expect((await playableNode.run(ctx)).outputs?.json).toMatchObject({ status: 'skipped' });
  });
  it.skipIf(!process.env.REA_TEST_CLI)('calls a real local REA over stdio', async () => {
    await writeFile(join(temp, 'mcp.json'), JSON.stringify({ mcpServers: { rea: { command: process.execPath, args: [process.env.REA_TEST_CLI, 'mcp'] } } }));
    const source = await readPlayable(path);
    const signal = new AbortController().signal;
    const extracted = await extractPlayable(temp, path, source.sha256, inspectPlayable(source.html), signal);
    const result = await inspectScripts(extracted.scriptsDir, extracted.sources, signal);
    expect(result.sources).toEqual(['S1.js']); expect(result.summary).toContain('parent_evidence_id');
  }, 180000);
});
