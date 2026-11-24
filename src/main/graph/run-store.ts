import { promises as fsp } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import type { GraphRunResult } from './engine';
import { assertInside, isInside, readJson, writeJsonAtomic } from '../utils/fs';

export interface RunSummary {
  runId: string;
  graphId: string;
  status: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  nodeCount: number;
  error?: string;
}

export interface ArtifactReadResult {
  path: string;
  name: string;
  mime: string;
  size: number;
  encoding: 'utf8' | 'base64';
  content: string;
}

/**
 * 运行记录与产物读取。用户图运行目录：
 * <project>/.dev/cocos-ai-agent/workflows/<graphId>/runs/<runId>/
 */
export class RunStore {
  private readonly workflowsRoot: string;

  constructor(private readonly projectRoot: string) {
    this.workflowsRoot = join(projectRoot, '.dev', 'cocos-ai-agent', 'workflows');
  }

  runDir(graphId: string, runId: string): string {
    return join(this.workflowsRoot, safeSegment(graphId), 'runs', safeSegment(runId));
  }

  async save(result: GraphRunResult): Promise<void> {
    const file = join(this.runDir(result.graphId, result.runId), 'run.json');
    await writeJsonAtomic(file, result);
  }

  async listRuns(graphId: string): Promise<RunSummary[]> {
    const runsRoot = join(this.workflowsRoot, safeSegment(graphId), 'runs');
    let entries;
    try {
      entries = await fsp.readdir(runsRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const summaries: RunSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const run = await readJson<GraphRunResult>(join(runsRoot, entry.name, 'run.json'));
      if (!run) continue;
      summaries.push({
        runId: run.runId,
        graphId: run.graphId,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        durationMs: run.durationMs,
        nodeCount: Object.keys(run.nodes ?? {}).length,
        ...(run.error ? { error: run.error } : {}),
      });
    }
    return summaries.sort((a, b) => b.startedAt - a.startedAt);
  }

  async loadRun(graphId: string, runId: string): Promise<GraphRunResult | null> {
    return readJson<GraphRunResult>(join(this.runDir(graphId, runId), 'run.json'));
  }

  async readArtifact(path: string, maxBytes = 2 * 1024 * 1024): Promise<ArtifactReadResult> {
    const docs = join(this.projectRoot, 'docs', 'cocos-ai-agent');
    const root = isInside(docs, path) ? docs : this.workflowsRoot;
    const lexical = assertInside(root, resolve(path));
    const project = await fsp.realpath(this.projectRoot);
    const target = assertInside(resolve(project, relative(this.projectRoot, root)), await fsp.realpath(lexical));
    const stat = await fsp.stat(target);
    if (stat.size > maxBytes) {
      throw new Error(`产物超过预览上限（${stat.size} > ${maxBytes} 字节）。`);
    }
    const data = await fsp.readFile(target);
    const mime = mimeFor(target);
    const text = isTextMime(mime);
    return {
      path: target,
      name: target.split(/[\\/]/).pop() ?? target,
      mime,
      size: stat.size,
      encoding: text ? 'utf8' : 'base64',
      content: text ? data.toString('utf8') : data.toString('base64'),
    };
  }

  /** 只允许删除本插件 workflows 目录下的运行记录。 */
  async deleteRun(graphId: string, runId: string): Promise<void> {
    const dir = this.runDir(graphId, runId);
    assertInside(this.workflowsRoot, dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function safeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  return sanitized || 'item';
}

function mimeFor(file: string): string {
  switch (extname(file).toLowerCase()) {
    case '.md':
      return 'text/markdown';
    case '.json':
      return 'application/json';
    case '.txt':
    case '.log':
      return 'text/plain';
    case '.html':
      return 'text/html';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.mp4':
      return 'video/mp4';
    case '.mp3':
      return 'audio/mpeg';
    default:
      return 'application/octet-stream';
  }
}

function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json';
}
