import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { ArtifactRef } from '../../../shared/graph';
import type { NodeDefinition } from './types';

export const mediaNodes: NodeDefinition[] = [
  {
    type: 'media.video-frames',
    category: 'media',
    label: '视频截帧',
    description: '用 ffmpeg 等间隔截取视频帧，默认 30 张；缺失 ffmpeg 时节点报错。',
    inputs: [{ name: 'video', type: 'video', required: false }],
    outputs: [
      { name: 'images', type: 'image[]', required: true },
      { name: 'frames', type: 'json', required: true },
    ],
    paramsSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '截帧数量，默认 30' },
        maxWidth: { type: 'number', description: '最大宽度，默认 960' },
      },
      additionalProperties: true,
    },
    requires: ['ffmpeg'],
    async run(ctx) {
      const videoPath = artifactPath(ctx.inputs.video);
      if (!videoPath) {
        ctx.log('warn', '没有视频输入：请给上游视频节点填入路径并取消“禁用（旁路）”。');
        return { outputs: { images: [], frames: { available: false, reason: '没有视频输入' } } };
      }
      const count = clamp(ctx.params.count, 30, 1, 60);
      const maxWidth = clamp(ctx.params.maxWidth, 960, 160, 4096);
      const duration = await probeDuration(videoPath);
      const temp = await fsp.mkdtemp(join(tmpdir(), 'cocos-agent-frames-'));
      const artifacts: ArtifactRef[] = [];
      try {
        const fps = duration > 0 ? Math.max(0.01, count / duration) : 1;
        await runCommand('ffmpeg', [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          videoPath,
          '-vf',
          `fps=${fps},scale='min(${maxWidth},iw)':-2`,
          '-frames:v',
          String(count),
          '-q:v',
          '2',
          join(temp, 'frame-%03d.jpg'),
        ], 180_000);
        const files = (await fsp.readdir(temp))
          .filter((name) => /^frame-\d+\.jpe?g$/i.test(name))
          .sort();
        for (const [index, name] of files.entries()) {
          const content = await fsp.readFile(join(temp, name));
          const artifact = await ctx.writeArtifact({
            path: `frames/${String(index + 1).padStart(3, '0')}.jpg`,
            content,
            type: 'image',
            name,
          });
          artifacts.push(artifact);
        }
      } finally {
        await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined);
      }
      ctx.log('info', `截取 ${artifacts.length} 帧（视频 ${duration.toFixed(1)}s）`);
      return {
        outputs: {
          images: artifacts,
          frames: { available: true, durationSeconds: duration, count: artifacts.length, files: artifacts.map((item) => item.path) },
        },
        artifacts,
      };
    },
  },
  {
    type: 'media.image-caption',
    category: 'media',
    label: '图片描述',
    description: '用视觉模型逐图/批量生成描述与要点；无图片时返回空结果。',
    inputs: [{ name: 'images', type: 'image[]', required: false }],
    outputs: [
      { name: 'json', type: 'json', required: true },
      { name: 'markdown', type: 'markdown', required: true },
    ],
    paramsSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图片理解要求' },
        visionProfileId: { type: 'string', description: '视觉模型 profile' },
      },
      additionalProperties: true,
    },
    async run(ctx) {
      const refs = Array.isArray(ctx.inputs.images) ? ctx.inputs.images : [];
      if (!refs.length) {
        ctx.log('warn', '没有图片输入，跳过图片识别（检查上游视频是否启用并成功截帧）。');
        return { outputs: { json: { images: [] }, markdown: '（无图片）' } };
      }
      const images = await loadImages(refs);
      if (!images.length) {
        return { outputs: { json: { images: [], warning: '图片不可读取' }, markdown: '（图片不可读取）' } };
      }
      const prompt =
        typeof ctx.params.prompt === 'string' && ctx.params.prompt.trim()
          ? ctx.params.prompt
          : '请逐张描述这些视频参考帧的界面、核心玩法、视觉风格与可复用元素，并输出 JSON。';
      const result = await ctx.agent({
        prompt,
        images,
        ...(typeof ctx.params.visionProfileId === 'string' ? { visionProfileId: ctx.params.visionProfileId } : {}),
      });
      const parsed = parseJson(result.text);
      return {
        outputs: {
          markdown: result.text,
          json: parsed ?? { text: result.text, imageCount: images.length },
        },
      };
    },
  },
  {
    type: 'analysis.project-scan',
    category: 'analysis',
    label: '项目分析',
    description: '通过主进程工具读取场景/资源/脚本概况，输出 project 类型。',
    inputs: [],
    outputs: [{ name: 'project', type: 'project', required: true }],
    paramsSchema: {
      type: 'object',
      properties: {
        maxNodes: { type: 'number', description: '场景节点采样上限，默认 500' },
      },
      additionalProperties: true,
    },
    async run(ctx) {
      const maxNodes = clamp(ctx.params.maxNodes, 500, 20, 2000);
      const [tree, assets, scenes, prefabs] = await Promise.all([
        ctx.tool('scene_query_node_tree', { depth: 6, maxNodes }),
        ctx.tool('asset_query_assets', { pattern: 'db://assets/**/*' }),
        ctx.tool('asset_query_assets', { ccType: 'cc.SceneAsset', pattern: 'db://assets/**/*' }),
        ctx.tool('asset_query_assets', { ccType: 'cc.Prefab', pattern: 'db://assets/**/*' }),
      ]);
      const summarize = (name: string, result: { ok: boolean; data?: unknown; error?: { message?: string } }): unknown => {
        if (!result.ok) return { error: result.error?.message ?? `${name} failed` };
        return result.data;
      };
      const project = {
        scanners: {
          scene: summarize('scene', tree as never),
          assets: summarize('assets', assets as never),
          scenes: summarize('scenes', scenes as never),
          prefabs: summarize('prefabs', prefabs as never),
        },
        constraints: ['H5/Web', 'Cocos Creator 3.8.8'],
        warnings: [],
      };
      ctx.log('info', '项目分析完成');
      return { outputs: { project } };
    },
  },
  {
    type: 'analysis.rea-reverse',
    category: 'analysis',
    label: 'REA 逆向',
    description: '可选参考试玩逆向；未配置 REA 或未提供输入时返回 available:false，不阻塞计划。',
    inputs: [{ name: 'artifact', type: 'artifact', required: false }],
    outputs: [{ name: 'json', type: 'json', required: true }],
    paramsSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '逆向侧重点' },
      },
      additionalProperties: true,
    },
    requires: ['rea'],
    async run(ctx) {
      const input = ctx.inputs.artifact;
      if (!input) {
        return { outputs: { json: { available: false, reason: '未提供参考试玩' } } };
      }
      ctx.log('warn', 'REA 逆向节点尚未启用；返回 available:false');
      return {
        outputs: {
          json: {
            available: false,
            reason: 'REA MCP 未配置或未实现调用；参考试玩可手动提供 UI/流程说明',
          },
        },
      };
    },
  },
];

function artifactPath(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as { path?: unknown; url?: unknown };
    if (typeof record.path === 'string') return record.path;
    if (typeof record.url === 'string' && !record.url.includes('://')) return record.url;
  }
  return '';
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

async function probeDuration(file: string): Promise<number> {
  const output = await runCommand('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    file,
  ], 30_000);
  const duration = Number(output.trim());
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function runCommand(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).trim().slice(0, 1000);
        reject(new Error(`${command} 执行失败：${detail}`));
      } else {
        resolve(String(stdout));
      }
    });
  });
}

async function loadImages(refs: unknown[]): Promise<Array<{ type: 'image'; data: string; mimeType: string }>> {
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  for (const item of refs) {
    const path = artifactPath(item);
    if (!path) continue;
    try {
      const data = await fsp.readFile(path);
      images.push({ type: 'image', data: data.toString('base64'), mimeType: mimeFor(path) });
    } catch {
      // 跳过不可读图片
    }
  }
  return images;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function mimeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}
