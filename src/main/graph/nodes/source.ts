import { isLocalPlayableHtml } from '../../../shared/playable';
import type { ArtifactRef } from '../../../shared/graph';
import type { NodeDefinition } from './types';

function textParam(params: Record<string, unknown>, key = 'text'): string {
  const value = params[key];
  return typeof value === 'string' ? value : '';
}

function fileName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
}

function fileRef(path: string, type: ArtifactRef['type'] = 'file'): ArtifactRef {
  return {
    id: path,
    type,
    name: fileName(path),
    ...(path.includes('://') ? { url: path } : { path }),
  };
}

export const sourceNodes: NodeDefinition[] = [
  {
    type: 'input.text',
    category: 'source',
    label: '文本输入',
    description: '策划文档、需求、补充说明或任意纯文本。',
    inputs: [],
    outputs: [{ name: 'text', type: 'text', required: true }],
    paramsSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '文本内容' },
        placeholder: { type: 'string', description: '空态提示' },
      },
      additionalProperties: true,
    },
    uiSchema: { text: { control: 'textarea', rows: 8 } },
    async run(ctx) {
      const text = textParam(ctx.params);
      ctx.log('info', `文本输入 ${text.length} 字符`);
      return { outputs: { text } };
    },
  },
  {
    type: 'input.markdown',
    category: 'source',
    label: 'Markdown 输入',
    description: 'Markdown 文档输入，输出 markdown 类型。',
    inputs: [],
    outputs: [{ name: 'markdown', type: 'markdown', required: true }],
    paramsSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Markdown 内容' } },
      additionalProperties: true,
    },
    uiSchema: { text: { control: 'textarea', rows: 10 } },
    async run(ctx) {
      return { outputs: { markdown: textParam(ctx.params) } };
    },
  },
  {
    type: 'input.file',
    category: 'source',
    label: '文件输入',
    description: '引用一个本地文件或工程内资源；输出 artifact 引用。',
    inputs: [],
    outputs: [{ name: 'artifact', type: 'artifact', required: true }],
    paramsSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '绝对路径、db:// 或相对路径' },
        name: { type: 'string', description: '显示名' },
      },
      required: ['path'],
      additionalProperties: true,
    },
    async run(ctx) {
      const path = textParam(ctx.params, 'path');
      if (!path) throw new Error('input.file 缺少 params.path');
      const ref = fileRef(path);
      if (typeof ctx.params.name === 'string' && ctx.params.name.trim()) ref.name = ctx.params.name.trim();
      return { outputs: { artifact: ref } };
    },
  },
  {
    type: 'input.images',
    category: 'source',
    label: '图片输入',
    description: '手动选择或粘贴一组图片路径/URL，输出 image[]。',
    inputs: [],
    outputs: [{ name: 'images', type: 'image[]', required: true }],
    paramsSchema: {
      type: 'object',
      properties: {
        images: {
          type: 'array',
          description: '图片路径或 URL',
          items: { type: 'string' },
        },
      },
      additionalProperties: true,
    },
    uiSchema: { images: { control: 'image-list' } },
    async run(ctx) {
      const raw = Array.isArray(ctx.params.images) ? ctx.params.images : [];
      const images = raw
        .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
        .map((path) => fileRef(path, 'image'));
      return { outputs: { images } };
    },
  },
  {
    type: 'input.video',
    category: 'source',
    label: '视频输入',
    description: '引用参考视频文件；后续由 media.video-frames 截帧。',
    inputs: [],
    outputs: [{ name: 'video', type: 'video', required: true }],
    paramsSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '视频路径或 URL' },
      },
      required: ['path'],
      additionalProperties: true,
    },
    async run(ctx) {
      const path = textParam(ctx.params, 'path');
      if (!path) throw new Error('input.video 缺少 params.path');
      return { outputs: { video: fileRef(path, 'video') } };
    },
  },
  {
    type: 'input.reference-playable',
    category: 'source',
    label: '参考试玩',
    description: '选择本地 HTML 试玩文件（.html）。',
    inputs: [],
    outputs: [{ name: 'artifact', type: 'artifact', required: true }],
    paramsSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本地 .html 文件绝对路径' },
        name: { type: 'string', description: '显示名' },
      },
      required: ['path'],
      additionalProperties: true,
    },
    async run(ctx) {
      const path = textParam(ctx.params, 'path');
      if (!isLocalPlayableHtml(path)) throw new Error('参考试玩仅支持本地 .html 文件的绝对路径');
      const ref = fileRef(path, 'file');
      if (typeof ctx.params.name === 'string' && ctx.params.name.trim()) ref.name = ctx.params.name.trim();
      return { outputs: { artifact: ref } };
    },
  },
];
