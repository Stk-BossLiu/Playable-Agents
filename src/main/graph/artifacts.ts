import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { ArtifactRef } from '../../shared/graph';
import { assertInside, ensureProjectDirectory } from '../utils/fs';
import type { WriteArtifactInput } from './nodes/types';

/**
 * 运行产物存储。G3.5 会在此基础上增加 run.json、预览 API 和 artifact 索引。
 * 当前先保证节点能安全写文件并返回 ArtifactRef。
 */
export class ArtifactStore {
  private readonly workflowsRoot: string;

  constructor(
    private readonly projectRoot: string,
    private readonly graphId: string,
  ) {
    this.workflowsRoot = join(projectRoot, '.dev', 'cocos-ai-agent', 'workflows');
  }

  runDir(runId: string): string {
    return join(this.workflowsRoot, safeSegment(this.graphId), 'runs', safeSegment(runId));
  }

  nodeDir(runId: string, nodeId: string): string {
    return join(this.runDir(runId), 'artifacts', safeSegment(nodeId));
  }

  async write(runId: string, nodeId: string, input: WriteArtifactInput): Promise<ArtifactRef> {
    const nodeDir = ['markdown', 'text', 'json'].includes(input.type)
      ? join(this.projectRoot, 'docs', 'cocos-ai-agent', safeSegment(this.graphId), safeSegment(runId), safeSegment(nodeId))
      : this.nodeDir(runId, nodeId);
    const target = resolve(nodeDir, input.path);
    const rel = relative(resolve(nodeDir), target);
    if (!rel || rel.startsWith('..') || resolve(nodeDir, rel) !== target) {
      throw new Error(`Artifact path escapes node directory: ${input.path}`);
    }
    assertInside(this.projectRoot, target);
    await ensureProjectDirectory(this.projectRoot, dirname(target));
    const data = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : Buffer.from(input.content);
    const tmp = `${target}.${randomUUID()}.tmp`;
    try { await fsp.writeFile(tmp, data, { flag: 'wx' }); await fsp.rename(tmp, target); }
    finally { await fsp.rm(tmp, { force: true }); }
    const hash = createHash('sha256').update(data).digest('hex');
    return {
      id: `${runId}:${nodeId}:${rel.replace(/\\/g, '/')}`,
      type: input.type,
      path: target,
      name: input.name ?? rel.replace(/\\/g, '/'),
      ...(input.summary ? { summary: input.summary } : {}),
      hash,
      ...(input.meta ? { meta: input.meta } : {}),
    };
  }
}

function safeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  return sanitized || 'item';
}
