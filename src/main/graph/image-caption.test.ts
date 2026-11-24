import { expect, it, vi } from 'vitest';
import { mediaNodes } from './nodes/media';
import type { NodeRunContext } from './nodes/types';

const caption = mediaNodes.find(node => node.type === 'media.image-caption')!;
const inputPath = 'package.json'; // The mock checks attachment routing, not pixel decoding.
function context(count: number, agent: NodeRunContext['agent']): NodeRunContext {
  return {
    runId: 'caption', graph: { schemaVersion: 1, id: 'g', name: 'g', version: '1', builtin: false, nodes: [], edges: [], groups: [] },
    node: { id: 'images', title: '图片', type: caption.type, position: { x: 0, y: 0 }, params: {} },
    params: {}, inputs: { images: Array<string>(count).fill(inputPath) }, signal: new AbortController().signal,
    log: vi.fn(), stream: vi.fn(), writeArtifact: vi.fn(), tool: vi.fn(), human: vi.fn(), agent,
  };
}

it('routes all 30 descriptions in frame order to both output ports', async () => {
  let offset = 0;
  const sizes: number[] = [];
  const result = await caption.run(context(30, async ({ images }) => {
    sizes.push(images!.length);
    const rows = images!.map(() => ({ index: ++offset, description: `画面 ${offset}` }));
    return { text: JSON.stringify({ images: rows.reverse() }) };
  }));
  expect(sizes).toEqual([4, 4, 4, 4, 4, 4, 4, 2]);
  expect(result.outputs?.json).toEqual({ imageCount: 30, images: Array.from({ length: 30 }, (_, i) => ({
    index: i + 1, name: inputPath, description: `画面 ${i + 1}`,
  })) });
  expect(result.outputs?.markdown).toContain('画面 30');
});

it('rejects an empty reply or duplicate index after a bounded format retry', async () => {
  const agent = vi.fn().mockResolvedValueOnce({ text: '' }).mockResolvedValueOnce({ text: JSON.stringify({
    images: [{ index: 1, description: '按钮' }, { index: 1, description: '结算' }],
  }) });
  await expect(caption.run(context(2, agent))).rejects.toThrow('第 1–2 张');
  expect(agent).toHaveBeenCalledTimes(2);
});
