import { promises as fsp } from 'node:fs';
import { basename, join } from 'node:path';
import {
  GRAPH_SCHEMA_VERSION,
  type GraphDocument,
  type GraphImportOptions,
  type GraphLoadResult,
  type GraphSaveOptions,
  type GraphSummary,
  type GraphValidationResult,
} from '../../shared/graph';
import { getExtensionRoot, projectPath } from '../utils/paths';
import { writeJsonAtomic } from '../utils/fs';
import { GraphError } from './errors';
import { assertValidGraph, validateGraph } from './validate';

const GRAPH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface GraphStoreOptions {
  projectRoot?: string;
  builtinRoot?: string;
}

export interface CreateGraphInput {
  id: string;
  name: string;
  description?: string;
}

export interface DuplicateGraphInput {
  id: string;
  newId?: string;
  name?: string;
}

/**
 * 图文件存储：用户图在 <project>/.dev/cocos-ai-agent/workflows/<id>/graph.json；
 * 内置图在扩展 resources/workflows/*.json，只读。
 */
export class GraphStore {
  private readonly projectRoot: string;
  private readonly workflowsRoot: string;
  private readonly builtinRoot: string;

  constructor(options: GraphStoreOptions = {}) {
    this.projectRoot = options.projectRoot ?? projectPath();
    this.workflowsRoot = join(this.projectRoot, '.dev', 'cocos-ai-agent', 'workflows');
    this.builtinRoot = options.builtinRoot ?? join(getExtensionRoot(), 'resources', 'workflows');
  }

  get userRoot(): string {
    return this.workflowsRoot;
  }

  get builtinsRoot(): string {
    return this.builtinRoot;
  }

  async list(): Promise<GraphSummary[]> {
    const builtin = await this.listBuiltin();
    const user = await this.listUser();
    return [...builtin, ...user];
  }

  async load(id: string): Promise<GraphLoadResult> {
    this.assertGraphId(id);
    const userFile = this.userGraphFile(id);
    if (await fileExists(userFile)) {
      const graph = await this.readDocument(userFile);
      return { graph, builtin: false, path: userFile };
    }

    const builtin = await this.findBuiltin(id);
    if (builtin) return { graph: builtin.graph, builtin: true, path: builtin.file };
    throw new GraphError('GRAPH_NOT_FOUND', `找不到图：${id}`);
  }

  async save(graph: GraphDocument, options: GraphSaveOptions = {}): Promise<GraphLoadResult> {
    if (graph?.builtin) {
      throw new GraphError(
        'GRAPH_BUILTIN_READONLY',
        '内置图只读；请先复制为自定义图再保存。',
      );
    }
    this.assertGraphId(graph?.id);
    const document = cloneGraph(graph);
    assertValidGraph(document);
    document.builtin = false;
    document.meta = {
      ...(document.meta ?? {}),
      createdAt: document.meta?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const file = this.userGraphFile(document.id);
    if (options.overwrite === false && (await fileExists(file))) {
      throw new GraphError('GRAPH_EXISTS', `图已存在：${document.id}`);
    }
    await writeJsonAtomic(file, document);
    return { graph: document, builtin: false, path: file };
  }

  async create(input: CreateGraphInput): Promise<GraphLoadResult> {
    this.assertGraphId(input.id);
    if (!input.name?.trim()) throw new GraphError('GRAPH_INVALID', '图名称不能为空。');
    if (await this.userGraphExists(input.id)) {
      throw new GraphError('GRAPH_EXISTS', `图已存在：${input.id}`);
    }
    const now = new Date().toISOString();
    const graph: GraphDocument = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      id: input.id,
      name: input.name.trim(),
      ...(input.description ? { description: input.description } : {}),
      builtin: false,
      version: '1.0.0',
      nodes: [],
      edges: [],
      groups: [],
      meta: { author: 'user', tags: [], createdAt: now, updatedAt: now },
    };
    return this.save(graph, { overwrite: false });
  }

  async duplicate(input: DuplicateGraphInput): Promise<GraphLoadResult> {
    const source = await this.load(input.id);
    const newId = input.newId ? this.assertGraphId(input.newId) : await this.nextAvailableId(`${source.graph.id}-copy`);
    if (await this.userGraphExists(newId)) {
      throw new GraphError('GRAPH_EXISTS', `图已存在：${newId}`);
    }
    const now = new Date().toISOString();
    const graph: GraphDocument = {
      ...cloneGraph(source.graph),
      id: newId,
      name: input.name?.trim() || `${source.graph.name} 副本`,
      builtin: false,
      meta: {
        ...(source.graph.meta ?? {}),
        author: source.builtin ? 'user' : source.graph.meta?.author ?? 'user',
        createdAt: now,
        updatedAt: now,
      },
    };
    return this.save(graph, { overwrite: false });
  }

  async delete(id: string): Promise<void> {
    this.assertGraphId(id);
    const dir = this.userGraphDir(id);
    if (!(await fileExists(dir))) {
      throw new GraphError('GRAPH_NOT_FOUND', `找不到自定义图：${id}`);
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }

  async importGraph(raw: unknown, options: GraphImportOptions = {}): Promise<GraphLoadResult> {
    const parsed = assertValidGraph(parseGraphValue(raw));
    const document = cloneGraph(parsed);
    const requestedId = options.id?.trim() || document.id;
    const id = this.assertGraphId(requestedId);
    if (options.id && (await this.userGraphExists(id))) {
      throw new GraphError('GRAPH_EXISTS', `图已存在：${id}`);
    }
    document.id = (await this.userGraphExists(id)) ? await this.nextAvailableId(`${id}-import`) : id;
    if (options.name?.trim()) document.name = options.name.trim();
    document.builtin = false;
    const now = new Date().toISOString();
    document.meta = {
      ...(document.meta ?? {}),
      createdAt: now,
      updatedAt: now,
    };
    if (options.save === false) {
      return { graph: document, builtin: false };
    }
    return this.save(document, { overwrite: false });
  }

  async exportGraph(id: string): Promise<string> {
    const loaded = await this.load(id);
    return `${JSON.stringify(loaded.graph, null, 2)}\n`;
  }

  validate(raw: unknown): GraphValidationResult {
    return validateGraph(raw);
  }

  private assertGraphId(id: unknown): string {
    if (typeof id !== 'string' || !GRAPH_ID_PATTERN.test(id)) {
      throw new GraphError(
        'GRAPH_ID_INVALID',
        '图 id 必须匹配 [A-Za-z0-9][A-Za-z0-9._-]{0,63}。',
      );
    }
    return id;
  }

  private userGraphDir(id: string): string {
    return join(this.workflowsRoot, id);
  }

  private userGraphFile(id: string): string {
    return join(this.userGraphDir(id), 'graph.json');
  }

  private async userGraphExists(id: string): Promise<boolean> {
    return fileExists(this.userGraphFile(id));
  }

  private async nextAvailableId(base: string): Promise<string> {
    const safe = normalizeGraphId(base);
    let candidate = safe;
    let index = 2;
    while (await this.userGraphExists(candidate)) {
      candidate = `${safe}-${index}`;
      index += 1;
    }
    return candidate;
  }

  private async readDocument(file: string): Promise<GraphDocument> {
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (error) {
      throw new GraphError('GRAPH_IO_ERROR', `读取图失败：${file}`, error);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new GraphError('GRAPH_INVALID', `图 JSON 解析失败：${file}`, error);
    }
    try {
      return assertValidGraph(raw);
    } catch (error) {
      if (error instanceof GraphError) throw error;
      throw new GraphError('GRAPH_INVALID', `图校验失败：${file}`, error);
    }
  }

  private async listBuiltin(): Promise<GraphSummary[]> {
    const files = await jsonFilesIn(this.builtinRoot);
    const summaries: GraphSummary[] = [];
    for (const file of files) {
      const fallbackId = basename(file, '.json');
      try {
        const graph = await this.readDocument(file);
        summaries.push(summarize(graph, true));
      } catch (error) {
        summaries.push(invalidSummary(fallbackId, true, error));
      }
    }
    return summaries.sort(compareSummary);
  }

  private async listUser(): Promise<GraphSummary[]> {
    let entries;
    try {
      entries = await fsp.readdir(this.workflowsRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const summaries: GraphSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !GRAPH_ID_PATTERN.test(entry.name)) continue;
      const file = this.userGraphFile(entry.name);
      if (!(await fileExists(file))) continue; // 只有 runs/ 没有 graph.json 的目录不是工作流
      try {
        const graph = await this.readDocument(file);
        summaries.push(summarize(graph, false));
      } catch (error) {
        summaries.push(invalidSummary(entry.name, false, error));
      }
    }
    return summaries.sort(compareSummary);
  }

  private async findBuiltin(id: string): Promise<{ graph: GraphDocument; file: string } | null> {
    const files = await jsonFilesIn(this.builtinRoot);
    let invalidMatch: { file: string; error: unknown } | null = null;
    for (const file of files) {
      try {
        const graph = await this.readDocument(file);
        if (graph.id === id || basename(file, '.json') === id) return { graph, file };
      } catch (error) {
        if (basename(file, '.json') === id) invalidMatch = { file, error };
      }
    }
    if (invalidMatch) {
      const message = errorMessage(invalidMatch.error);
      throw new GraphError('GRAPH_INVALID', `内置图无效：${invalidMatch.file}（${message}）`);
    }
    return null;
  }
}

function parseGraphValue(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new GraphError('GRAPH_IMPORT_INVALID', '导入内容不是合法 JSON。', error);
    }
  }
  if (raw && typeof raw === 'object') return raw;
  throw new GraphError('GRAPH_IMPORT_INVALID', '导入内容必须是 JSON 对象或字符串。');
}

function cloneGraph(graph: GraphDocument): GraphDocument {
  return JSON.parse(JSON.stringify(graph)) as GraphDocument;
}

function summarize(graph: GraphDocument, builtin: boolean): GraphSummary {
  return {
    id: graph.id,
    name: graph.name,
    ...(graph.description ? { description: graph.description } : {}),
    builtin,
    version: graph.version,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    ...(graph.meta?.updatedAt ? { updatedAt: graph.meta.updatedAt } : {}),
  };
}

function invalidSummary(id: string, builtin: boolean, error: unknown): GraphSummary {
  return {
    id,
    name: id,
    builtin,
    version: '?',
    nodeCount: 0,
    edgeCount: 0,
    invalid: errorMessage(error),
  };
}

function normalizeGraphId(value: string): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64);
  return GRAPH_ID_PATTERN.test(slug) ? slug : 'graph';
}

function compareSummary(a: GraphSummary, b: GraphSummary): number {
  if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
  return a.name.localeCompare(b.name, 'zh-CN');
}

async function jsonFilesIn(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof GraphError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
