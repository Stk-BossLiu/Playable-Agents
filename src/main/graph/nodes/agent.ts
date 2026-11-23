import { promises as fsp } from 'node:fs';
import { extname } from 'node:path';
import type { ArtifactRef } from '../../../shared/graph';
import type { NodeDefinition, NodeRunContext } from './types';

const ROLE_PROMPTS: Record<string, string> = {
  pm: '你是试玩项目的产品经理。请把需求整理成可执行的目标、范围、风险与验收标准。',
  designer: '你是试玩项目的策划/设计师。请关注核心循环、场景、UI、节奏与可复用素材。',
  developer: '你是 Cocos Creator H5/Web 开发工程师。请给出具体到文件/节点/组件的实现步骤。',
  validator: '你是试玩项目的验证者。请检查需求覆盖、可运行性、性能与验收条件，指出缺口。',
};

export const agentNodes: NodeDefinition[] = [
  {
    type: 'agent.llm',
    category: 'agent',
    label: '文本 Agent',
    description: '调用 Pi/LLM，把上游上下文生成 Markdown，并尝试解析 JSON。',
    inputs: [{ name: 'context', type: 'any', required: false }],
    outputs: [
      { name: 'markdown', type: 'markdown', required: true },
      { name: 'json', type: 'json', required: true },
    ],
    paramsSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '提示词模板，支持 {{input}} 与 {{json}}' },
        systemPrompt: { type: 'string', description: '系统提示词' },
        modelProfileId: { type: 'string', description: '模型 profile（可选）' },
        provider: { type: 'string', description: '覆盖 Pi provider' },
        model: { type: 'string', description: '覆盖 Pi model' },
        thinking: { type: 'string', description: '思考级别' },
      },
      additionalProperties: true,
    },
    uiSchema: { prompt: { control: 'textarea', rows: 8 }, systemPrompt: { control: 'textarea', rows: 4 } },
    async run(ctx) {
      const text = await runPrompt(ctx, ctx.inputs.context, '请基于以下输入完成任务。');
      return {
        outputs: {
          markdown: text,
          json: parseJson(text) ?? { text },
        },
      };
    },
  },
  {
    type: 'agent.structured',
    category: 'agent',
    label: '结构化 Agent',
    description: '要求模型只返回 JSON，解析失败自动重试一次。',
    inputs: [{ name: 'context', type: 'any', required: false }],
    outputs: [{ name: 'json', type: 'json', required: true }],
    paramsSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '任务提示词，支持 {{input}}' },
        schema: { type: 'object', description: '期望的 JSON Schema 或示例结构' },
        systemPrompt: { type: 'string' },
        modelProfileId: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
      },
      additionalProperties: true,
    },
    uiSchema: { prompt: { control: 'textarea', rows: 8 } },
    async run(ctx) {
      const input = stringifyInput(ctx.inputs.context);
      const prompt = renderTemplate(stringParam(ctx.params, 'prompt') || '请根据输入输出 JSON。', input);
      const schemaText = ctx.params.schema ? `\n返回结构要求：\n${JSON.stringify(ctx.params.schema, null, 2)}` : '';
      const systemPrompt =
        `${stringParam(ctx.params, 'systemPrompt')}\n你必须只输出合法 JSON，不要 Markdown 代码块，不要解释。${schemaText}`.trim();
      let lastText = '';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await ctx.agent({
          prompt: attempt === 0 ? prompt : `${prompt}\n\n上一次输出无法解析为 JSON：\n${lastText.slice(0, 2000)}\n请重新输出合法 JSON。`,
          systemPrompt,
          ...agentOverrides(ctx),
        });
        lastText = result.text;
        const parsed = parseJson(lastText);
        if (parsed !== undefined) return { outputs: { json: parsed } };
        ctx.log('warn', `结构化输出解析失败（第 ${attempt + 1} 次）`);
      }
      throw new Error(`结构化输出不是合法 JSON：${lastText.slice(0, 500)}`);
    },
  },
  {
    type: 'agent.role',
    category: 'agent',
    label: '角色 Agent',
    description: '按 PM/Designer/Developer/Validator 预设提示词调用模型。',
    inputs: [{ name: 'context', type: 'any', required: false }],
    outputs: [
      { name: 'markdown', type: 'markdown', required: true },
      { name: 'json', type: 'json', required: true },
    ],
    paramsSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['pm', 'designer', 'developer', 'validator'] },
        prompt: { type: 'string', description: '附加任务，支持 {{input}}' },
        systemPrompt: { type: 'string', description: '覆盖角色系统提示词' },
        modelProfileId: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
      },
      additionalProperties: true,
    },
    async run(ctx) {
      const role = stringParam(ctx.params, 'role') || 'pm';
      const systemRole = ROLE_PROMPTS[role] ?? ROLE_PROMPTS.pm;
      const input = stringifyInput(ctx.inputs.context);
      const prompt = renderTemplate(stringParam(ctx.params, 'prompt') || '请基于以下上下文完成你的工作。\n\n{{input}}', input);
      const result = await ctx.agent({
        prompt,
        systemPrompt: `${systemRole}\n\n${stringParam(ctx.params, 'systemPrompt')}`.trim(),
        ...agentOverrides(ctx),
      });
      return {
        outputs: { markdown: result.text, json: parseJson(result.text) ?? { text: result.text } },
        ...(result.model ? { meta: { model: result.model } } : {}),
      };
    },
  },
  {
    type: 'agent.vision',
    category: 'agent',
    label: '视觉 Agent',
    description: '把上游图片送入视觉模型；未配置视觉 profile 时使用默认模型。',
    inputs: [
      { name: 'images', type: 'image[]', required: true },
      { name: 'text', type: 'text', required: false },
    ],
    outputs: [
      { name: 'json', type: 'json', required: true },
      { name: 'markdown', type: 'markdown', required: true },
    ],
    paramsSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '识别/理解要求，支持 {{input}}' },
        visionProfileId: { type: 'string', description: '视觉模型 profile；省略用默认' },
        modelProfileId: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
      },
      additionalProperties: true,
    },
    async run(ctx) {
      const images = await loadImages(ctx.inputs.images);
      if (!images.length) throw new Error('agent.vision 没有收到可读取的图片。');
      const inputText = stringifyInput(ctx.inputs.text);
      const prompt = renderTemplate(
        stringParam(ctx.params, 'prompt') || '请识别并理解这些图片，输出结构化要点。\n\n{{input}}',
        inputText,
      );
      const result = await ctx.agent({
        prompt,
        images,
        ...agentOverrides(ctx),
        ...(stringParam(ctx.params, 'visionProfileId')
          ? { visionProfileId: stringParam(ctx.params, 'visionProfileId') }
          : {}),
      });
      return {
        outputs: { markdown: result.text, json: parseJson(result.text) ?? { text: result.text } },
        ...(result.model ? { meta: { model: result.model } } : {}),
      };
    },
  },
];

async function runPrompt(ctx: NodeRunContext, input: unknown, fallbackPrompt: string): Promise<string> {
  const prompt = renderTemplate(stringParam(ctx.params, 'prompt') || `${fallbackPrompt}\n\n{{input}}`, stringifyInput(input));
  const result = await ctx.agent({
    prompt,
    systemPrompt: stringParam(ctx.params, 'systemPrompt'),
    ...agentOverrides(ctx),
  });
  return result.text;
}

function agentOverrides(ctx: NodeRunContext): {
  modelProfileId?: string;
  provider?: string;
  model?: string;
  thinking?: string;
} {
  const modelProfileId = stringParam(ctx.params, 'modelProfileId');
  const provider = stringParam(ctx.params, 'provider');
  const model = stringParam(ctx.params, 'model');
  const thinking = stringParam(ctx.params, 'thinking');
  return {
    ...(modelProfileId ? { modelProfileId } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

function renderTemplate(template: string, input: string): string {
  return template.replace(/\{\{\s*(input|json|value)\s*\}\}/g, input);
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : '';
}

function stringifyInput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseJson(text: string): unknown {
  const source = text.trim();
  if (!source) return undefined;
  try {
    return JSON.parse(source);
  } catch {
    // 模型常把 JSON 放在代码块里
  }
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      return undefined;
    }
  }
  const starts = [source.indexOf('{'), source.indexOf('[')].filter((index) => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const end = Math.max(source.lastIndexOf('}'), source.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(source.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function loadImages(value: unknown): Promise<Array<{ type: 'image'; data: string; mimeType: string }>> {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  for (const item of values) {
    const ref = item as Partial<ArtifactRef> | null;
    const path = typeof ref?.path === 'string' ? ref.path : typeof item === 'string' ? item : '';
    if (!path) continue;
    const data = await fsp.readFile(path);
    images.push({ type: 'image', data: data.toString('base64'), mimeType: mimeFor(path) });
  }
  return images;
}

function mimeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/png';
  }
}
