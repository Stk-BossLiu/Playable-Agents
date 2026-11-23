import type { NodeDefinition } from './types';

export const humanNodes: NodeDefinition[] = [
  {
    type: 'human.approval',
    category: 'human',
    label: '人工审批',
    description: '暂停图运行，等待用户批准或打回；只有开发计划需要审批。',
    inputs: [
      { name: 'markdown', type: 'markdown', required: false },
      { name: 'json', type: 'json', required: false },
      { name: 'data', type: 'any', required: false },
    ],
    outputs: [
      { name: 'markdown', type: 'markdown', required: true },
      { name: 'json', type: 'json', required: true },
      { name: 'approved', type: 'json', required: true },
      { name: 'feedback', type: 'text', required: true },
    ],
    paramsSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '审批标题' },
        description: { type: 'string', description: '审批说明' },
        timeoutMs: { type: 'number', description: '等待超时毫秒；0 表示不超时' },
      },
      additionalProperties: true,
    },
    async run(ctx) {
      const title = typeof ctx.params.title === 'string' ? ctx.params.title : '确认开发计划';
      const description =
        typeof ctx.params.description === 'string'
          ? ctx.params.description
          : '请检查开发计划，批准后继续输出 dev-plan.md / dev-plan.json。';
      const result = await ctx.human({
        kind: 'approval',
        title,
        description,
        ...(typeof ctx.params.timeoutMs === 'number' ? { timeoutMs: ctx.params.timeoutMs } : {}),
        payload: { markdown: ctx.inputs.markdown, json: ctx.inputs.json, data: ctx.inputs.data },
      });
      const feedback = result.feedback ?? '';
      if (result.decision !== 'approve') {
        throw new Error(feedback ? `用户打回计划：${feedback}` : '用户拒绝了该计划。');
      }
      ctx.log('info', '用户已批准');
      return {
        outputs: {
          markdown: ctx.inputs.markdown ?? '',
          json: ctx.inputs.json ?? {},
          approved: true,
          feedback,
        },
      };
    },
  },
  {
    type: 'human.ask',
    category: 'human',
    label: '人工提问',
    description: '暂停图运行并向用户提问；回答写入 outputs。',
    inputs: [{ name: 'context', type: 'any', required: false }],
    outputs: [
      { name: 'answer', type: 'text', required: true },
      { name: 'data', type: 'any', required: true },
    ],
    paramsSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '问题' },
        options: { type: 'array', items: { type: 'string' }, description: '可选答案' },
        timeoutMs: { type: 'number' },
      },
      additionalProperties: true,
    },
    async run(ctx) {
      const question = typeof ctx.params.question === 'string' ? ctx.params.question : '请补充信息';
      const options = Array.isArray(ctx.params.options)
        ? ctx.params.options
            .filter((item): item is string => typeof item === 'string')
            .map((label, index) => ({ id: String(index + 1), label }))
        : undefined;
      const result = await ctx.human({
        kind: 'question',
        title: question,
        ...(options?.length ? { options } : {}),
        ...(typeof ctx.params.timeoutMs === 'number' ? { timeoutMs: ctx.params.timeoutMs } : {}),
        payload: ctx.inputs.context,
      });
      const answer = result.feedback ?? result.optionId ?? '';
      return { outputs: { answer, data: { ...(ctx.inputs.context ?? {}), answer } } };
    },
  },
];
