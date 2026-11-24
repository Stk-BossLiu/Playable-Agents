import { describe, expect, it } from 'vitest';
import { GraphEngine } from '../main/graph/engine';
import { NodeRegistry } from '../main/graph/nodes/registry';
import { sourceNodes } from '../main/graph/nodes/source';
import { logicNodes } from '../main/graph/nodes/logic';
import type { GraphDocument } from '../shared/graph';
import { handlePanelEvent, state } from './store';

describe('board node results', () => {
  it('delivers ordinary port values before run end, including on a cached run', async () => {
    const seen: string[] = [];
    const engine = new GraphEngine({
      registry: new NodeRegistry().registerAll([...sourceNodes, ...logicNodes]),
      projectRoot: '.',
      tool: async () => ({ ok: true, data: {} }),
      event(event) {
        handlePanelEvent(event);
        if (event.type === 'node-output' && event.payload.nodeId === 'merge') {
          expect(state.graphRun.status).toBe('running');
          seen.push(String(state.graphRun.nodes.merge.outputs?.value));
        }
      },
    });
    const graph: GraphDocument = {
      schemaVersion: 1, id: 'board-result-test', name: 'Test', version: '1', builtin: false, groups: [],
      nodes: [
        { id: 'input', type: 'input.text', title: 'Input', params: { text: 'sample' }, position: { x: 0, y: 0 } },
        { id: 'merge', type: 'logic.merge', title: 'Merge', position: { x: 300, y: 0 } },
      ],
      edges: [{ id: 'edge', from: { node: 'input', port: 'text' }, to: { node: 'merge', port: 'values' } }],
    };
    await engine.run(graph);
    await engine.run(graph);
    expect(seen).toEqual(['sample', 'sample']);
    expect(state.graphRun.graphId).toBe(graph.id);
    expect(state.graphRun.nodes.merge.cached).toBe(true);
  });
});
