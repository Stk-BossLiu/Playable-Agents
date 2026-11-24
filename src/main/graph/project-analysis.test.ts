import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GraphDocument } from '../../shared/graph';
import { roleJsonOutput } from './nodes/agent';
import { createNodeRegistry } from './nodes';
import { validateGraph } from './validate';

const graph: GraphDocument = JSON.parse(readFileSync('resources/workflows/playable-plan.json', 'utf8'));
const sections = ['资产清单', '玩法', '试玩整体流程', '节点树结构预建', '技术点分析', '开发计划', '需要用户协助点'];
const body = ['暂无已确认缺口', '点击选择角色', '选择 → 体验 → 结算', '```text\nCanvas\n  PlayButton\n```', '触摸事件', '绑定按钮并验证点击', '确认角色立绘'];
const sample = ['# 项目分析', ...sections.map((title, i) => `## ${i + 1}. ${title}\n${body[i]}`)].join('\n\n');

describe('built-in project analysis', () => {
  it('routes a valid graph with matching Markdown and JSON chapters', () => {
    expect(validateGraph(graph, { catalog: createNodeRegistry().catalog() }).valid).toBe(true);
    const params = graph.nodes.find(node => node.id === 'plan')?.params;
    expect(params?.reportSections).toEqual(sections);
    expect(roleJsonOutput(sample, params?.reportSections)).toEqual(Object.fromEntries(sections.map((title, i) => [title, body[i]])));
  });
  it('rejects a missing chapter before review', () => {
    expect(() => roleJsonOutput(sample.slice(0, sample.indexOf('## 7.')), sections)).toThrow('需要用户协助点');
  });
});
