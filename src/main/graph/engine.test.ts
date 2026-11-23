import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GraphDocument } from '../../shared/graph';
import { GraphEngine } from './engine';
import { NodeRegistry } from './nodes/registry';
import type { NodeDefinition } from './nodes/types';

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cocos-agent-engine-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function graph(nodes: GraphDocument['nodes'], edges: GraphDocument['edges'] = []): GraphDocument {
  return {
    schemaVersion: 1,
    id: 'engine-test',
    name: 'Engine Test',
    builtin: false,
    version: '1.0.0',
    nodes,
    edges,
    groups: [],
  };
}

function engine(definitions: NodeDefinition[]): GraphEngine {
  return new GraphEngine({
    registry: new NodeRegistry().registerAll(definitions),
    projectRoot: tempProject(),
    tool: async () => ({ ok: true, data: {} }),
  });
}

const slowNode: NodeDefinition = {
  type: 'test.slow',
  category: 'logic',
  label: 'Slow',
  description: 'slow test node',
  inputs: [],
  outputs: [{ name: 'text', type: 'text' }],
  paramsSchema: { type: 'object', properties: {} },
  async run() {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { outputs: { text: 'slow' } };
  },
};

describe('GraphEngine', () => {
  it('runs a graph and exposes node outputs', async () => {
    const registryEngine = engine([
      {
        type: 'test.echo',
        category: 'logic',
        label: 'Echo',
        description: 'echo',
        inputs: [{ name: 'in', type: 'text' }],
        outputs: [{ name: 'out', type: 'text' }],
        paramsSchema: { type: 'object', properties: {} },
        async run(ctx) {
          return { outputs: { out: `echo:${String(ctx.inputs.in ?? '')}` } };
        },
      },
      {
        type: 'test.source',
        category: 'source',
        label: 'Source',
        description: 'source',
        inputs: [],
        outputs: [{ name: 'out', type: 'text' }],
        paramsSchema: { type: 'object', properties: {} },
        async run() {
          return { outputs: { out: 'hello' } };
        },
      },
    ]);
    const result = await registryEngine.run(
      graph(
        [
          { id: 'source', type: 'test.source', title: 'Source', position: { x: 0, y: 0 } },
          { id: 'echo', type: 'test.echo', title: 'Echo', position: { x: 100, y: 0 } },
        ],
        [{ id: 'e1', from: { node: 'source', port: 'out' }, to: { node: 'echo', port: 'in' } }],
      ),
    );
    expect(result.status).toBe('success');
    expect(result.nodes.echo.outputs?.out).toBe('echo:hello');
  });

  it('retries a failed node', async () => {
    let attempts = 0;
    const registryEngine = engine([
      {
        type: 'test.flaky',
        category: 'logic',
        label: 'Flaky',
        description: 'flaky',
        inputs: [],
        outputs: [{ name: 'text', type: 'text' }],
        paramsSchema: { type: 'object', properties: {} },
        async run() {
          attempts += 1;
          if (attempts === 1) throw new Error('first failure');
          return { outputs: { text: 'ok' } };
        },
      },
    ]);
    const result = await registryEngine.run(
      graph([
        {
          id: 'flaky',
          type: 'test.flaky',
          title: 'Flaky',
          position: { x: 0, y: 0 },
          meta: { retry: 1 },
        },
      ]),
    );
    expect(result.status).toBe('success');
    expect(result.nodes.flaky.attempt).toBe(2);
    expect(attempts).toBe(2);
  });

  it('uses cache on a second identical run', async () => {
    let calls = 0;
    const registryEngine = engine([
      {
        type: 'test.count',
        category: 'logic',
        label: 'Count',
        description: 'count',
        inputs: [],
        outputs: [{ name: 'text', type: 'text' }],
        paramsSchema: { type: 'object', properties: {} },
        async run() {
          calls += 1;
          return { outputs: { text: `call-${calls}` } };
        },
      },
    ]);
    const document = graph([{ id: 'count', type: 'test.count', title: 'Count', position: { x: 0, y: 0 } }]);
    const first = await registryEngine.run(document);
    const second = await registryEngine.run(document);
    expect(first.nodes.count.cached).toBeUndefined();
    expect(second.nodes.count.cached).toBe(true);
    expect(calls).toBe(1);
  });

  it('cancels an active run', async () => {
    const registryEngine = engine([slowNode]);
    const promise = registryEngine.run(
      graph([{ id: 'slow', type: 'test.slow', title: 'Slow', position: { x: 0, y: 0 } }]),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const runId = registryEngine.getActiveRunIds()[0];
    expect(runId).toBeTruthy();
    expect(registryEngine.cancel(runId)).toBe(true);
    const result = await promise;
    expect(result.status).toBe('cancelled');
    expect(result.nodes.slow.state).toBe('cancelled');
  });

  it('injects agentType and agentRole into agent requests', async () => {
    const captured: { agentType?: string; agentRole?: string } = {};
    const roleNode: NodeDefinition = {
      type: 'agent.role',
      category: 'agent',
      label: 'Role',
      description: 'role',
      inputs: [],
      outputs: [{ name: 'markdown', type: 'markdown' }],
      paramsSchema: { type: 'object', properties: {} },
      async run(ctx) {
        await ctx.agent({ prompt: 'hi' });
        return { outputs: { markdown: 'ok' } };
      },
    };
    const registryEngine = new GraphEngine({
      registry: new NodeRegistry().register(roleNode),
      projectRoot: tempProject(),
      tool: async () => ({ ok: true, data: {} }),
      agent: async (request) => {
        captured.agentType = request.agentType;
        captured.agentRole = request.agentRole;
        return { text: 'ok' };
      },
    });
    const result = await registryEngine.run(
      graph([
        {
          id: 'role',
          type: 'agent.role',
          title: 'Role',
          position: { x: 0, y: 0 },
          params: { role: 'developer' },
        },
      ]),
    );
    expect(result.status).toBe('success');
    expect(captured.agentType).toBe('agent.role');
    expect(captured.agentRole).toBe('developer');
  });

  it('marks a run as error when a node throws', async () => {
    const registryEngine = engine([
      {
        type: 'test.fail',
        category: 'logic',
        label: 'Fail',
        description: 'fail',
        inputs: [],
        outputs: [{ name: 'text', type: 'text' }],
        paramsSchema: { type: 'object', properties: {} },
        async run() {
          throw new Error('boom');
        },
      },
    ]);
    const result = await registryEngine.run(
      graph([{ id: 'fail', type: 'test.fail', title: 'Fail', position: { x: 0, y: 0 } }]),
    );
    expect(result.status).toBe('error');
    expect(result.nodes.fail.state).toBe('error');
    expect(result.nodes.fail.error).toContain('boom');
  });
});
