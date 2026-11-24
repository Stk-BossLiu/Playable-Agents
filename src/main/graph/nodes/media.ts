import { playableNode } from '../playable/node';
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type { ArtifactRef } from '../../../shared/graph';
import type { NodeDefinition, NodeRunContext } from './types';

const CAPTION_BATCH_SIZE = 4;

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
        return { outputs: { json: { imageCount: 0, images: [] }, markdown: '（无图片）' } };
      }
      const captions: Array<{ index: number; name: string; description: string }> = [];
      for (let offset = 0; offset < refs.length; offset += CAPTION_BATCH_SIZE) {
        const batch = refs.slice(offset, offset + CAPTION_BATCH_SIZE);
        const range = `${offset + 1}–${offset + batch.length}`;
        ctx.log('info', `正在识别第 ${range} 张图片（共 ${refs.length} 张）`);
        try {
          captions.push(...await captionBatch(ctx, batch, offset));
        } catch (error) {
          throw new Error(`图片识别失败（第 ${range} 张）：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return {
        outputs: {
          json: { imageCount: captions.length, images: captions },
          markdown: captions.map(({ index, name, description }) => `### 第 ${index} 张 · ${name}\n${description}`).join('\n\n'),
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
      const project = {
        scanners: {
          scene: tree.ok ? tree.data : { error: tree.error.message },
          assets: summarizeAssets(assets),
          scenes: summarizeAssets(scenes),
          prefabs: summarizeAssets(prefabs),
        },
        constraints: ['H5/Web', 'Cocos Creator 3.8.8'],
        warnings: [],
      };
      ctx.log('info', '项目分析完成');
      return { outputs: { project } };
    },
  },
  playableNode,
];

/** Keep editor import metadata out of report prompts. Explicit sampling prevents false absence claims. */
function summarizeAssets(result: Awaited<ReturnType<NodeRunContext['tool']>>) {
  if (!result.ok) return { error: result.error.message };
  const data = result.data;
  if (!data || typeof data !== 'object' || !('assets' in data) || !Array.isArray(data.assets)) {
    return { error: '未取得可用的资产清单' };
  }
  const counts: Record<string, number> = Object.create(null);
  const paths: string[] = [];
  let pathChars = 0;
  let count = 0;
  const maxPathChars = 16000;
  for (const asset of data.assets) {
    if (!asset || asset.isDirectory) continue;
    const type = typeof asset.type === 'string' ? asset.type : 'unknown';
    counts[type] = (counts[type] ?? 0) + 1;
    count++;
    const path = artifactPath(asset);
    if (path && pathChars + path.length + 1 <= maxPathChars) {
      paths.push(path);
      pathChars += path.length + 1;
    }
  }
  const partial = paths.length < count || ('count' in data && Number(data.count) > data.assets.length);
  return { count, counts, paths, ...(partial ? { warning: '仅展示部分资源路径，未列出的资源需要核实。' } : {}) };
}

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

async function captionBatch(ctx: NodeRunContext, refs: unknown[], offset: number) {
  const paths = refs.map((ref, i) => {
    const path = artifactPath(ref);
    if (!path) throw new Error(`第 ${offset + i + 1} 张缺少文件路径`);
    return path;
  });
  const images = await Promise.all(paths.map(async (path) => ({
    type: 'image' as const, data: (await fsp.readFile(path)).toString('base64'), mimeType: mimeFor(path),
  })));
  const instructions = typeof ctx.params.prompt === 'string' && ctx.params.prompt.trim()
    ? ctx.params.prompt.trim() : '逐张描述实际可见的界面、玩法线索、视觉风格与可复用元素。';
  const indices = paths.map((_, i) => offset + i + 1);
  const prompt = `${instructions}\n附件依次对应编号 ${indices.join('、')}。只返回 JSON 对象，images 数组每张一项，index 为对应的整数编号，description 为该图具体可见内容的非空中文描述。相似帧也逐张描述。`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await ctx.agent({
      prompt: attempt ? `${prompt}\n请检查每个编号恰好出现一次，description 为字符串。` : prompt,
      images,
      ...(typeof ctx.params.visionProfileId === 'string' ? { visionProfileId: ctx.params.visionProfileId } : {}),
    });
    const parsed = parseJson(result.text);
    const rows = parsed && typeof parsed === 'object' && 'images' in parsed ? parsed.images : undefined;
    if (!Array.isArray(rows) || rows.length !== indices.length) continue;
    const descriptions = new Map<number, string>();
    for (const row of rows) {
      if (row && indices.includes(row.index) && typeof row.description === 'string' && row.description.trim()) {
        descriptions.set(row.index, row.description.trim());
      }
    }
    if (descriptions.size === indices.length) {
      return indices.map((index, i) => ({ index, name: basename(paths[i]), description: descriptions.get(index)! }));
    }
  }
  throw new Error('视觉模型两次回复均未提供完整的逐图描述，请检查视觉模型配置');
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
