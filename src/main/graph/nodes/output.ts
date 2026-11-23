import type { NodeDefinition } from './types';

function pathParam(params: Record<string, unknown>, fallback: string): string {
  const value = params.path;
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export const outputNodes: NodeDefinition[] = [
  {
    type: 'output.markdown',
    category: 'output',
    label: 'Markdown 输出',
    description: '把 markdown 输入写入运行产物目录，输出 artifact 引用。',
    inputs: [{ name: 'markdown', type: 'markdown', required: true }],
    outputs: [{ name: 'artifact', type: 'artifact', required: true }],
    paramsSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '产物相对路径，默认 output.md' },
        name: { type: 'string', description: '显示名' },
      },
      additionalProperties: true,
    },
    async run(ctx) {
      const relativePath = pathParam(ctx.params, 'output.md');
      const content = stringify(ctx.inputs.markdown);
      const artifact = await ctx.writeArtifact({
        path: relativePath,
        content,
        type: 'markdown',
        name: typeof ctx.params.name === 'string' ? ctx.params.name : relativePath,
        summary: content.slice(0, 160),
      });
      ctx.log('info', `写入 ${relativePath}（${content.length} 字符）`);
      return { outputs: { artifact }, artifacts: [artifact] };
    },
  },
  {
    type: 'output.json',
    category: 'output',
    label: 'JSON 输出',
    description: '把结构化数据写入 .json 文件，输出 artifact 引用。',
    inputs: [{ name: 'json', type: 'json', required: true }],
    outputs: [{ name: 'artifact', type: 'artifact', required: true }],
    paramsSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '产物相对路径，默认 output.json' },
        name: { type: 'string', description: '显示名' },
        pretty: { type: 'boolean', description: '是否格式化，默认 true' },
      },
      additionalProperties: true,
    },
    async run(ctx) {
      const relativePath = pathParam(ctx.params, 'output.json');
      const pretty = ctx.params.pretty !== false;
      const value = ctx.inputs.json;
      const content =
        typeof value === 'string' ? value : JSON.stringify(value, null, pretty ? 2 : undefined) ?? 'null';
      const artifact = await ctx.writeArtifact({
        path: relativePath,
        content: `${content}\n`,
        type: 'json',
        name: typeof ctx.params.name === 'string' ? ctx.params.name : relativePath,
        summary: content.slice(0, 160),
      });
      return { outputs: { artifact }, artifacts: [artifact] };
    },
  },
  {
    type: 'output.report',
    category: 'output',
    label: '报告输出',
    description: '把任意输入汇总为报告文件，输出 artifact 引用。',
    inputs: [{ name: 'data', type: 'any', required: false }],
    outputs: [{ name: 'artifact', type: 'artifact', required: true }],
    paramsSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '产物相对路径，默认 report.md' },
        title: { type: 'string', description: '报告标题' },
      },
      additionalProperties: true,
    },
    async run(ctx) {
      const relativePath = pathParam(ctx.params, 'report.md');
      const title = typeof ctx.params.title === 'string' ? ctx.params.title : '运行报告';
      const body = stringify(ctx.inputs.data);
      const content = `# ${title}\n\n${body}\n`;
      const artifact = await ctx.writeArtifact({
        path: relativePath,
        content,
        type: 'markdown',
        name: relativePath,
        summary: body.slice(0, 160),
      });
      return { outputs: { artifact }, artifacts: [artifact] };
    },
  },
  {
    type: 'output.artifact',
    category: 'output',
    label: '产物透传',
    description: '把上游 artifact 引用透传到输出，供后续节点或运行结果使用。',
    inputs: [{ name: 'artifact', type: 'artifact', required: true }],
    outputs: [{ name: 'artifact', type: 'artifact', required: true }],
    paramsSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    async run(ctx) {
      return { outputs: { artifact: ctx.inputs.artifact } };
    },
  },
];
