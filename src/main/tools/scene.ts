import { request } from '../utils/ipc-editor';
import type { ToolDef } from '../bridge/schema';
import { editorTool, fail, numArg, ok, strArg, truncate, uuidArg } from './common';

async function currentSceneInfo(): Promise<Record<string, unknown>> {
  const [uuid, dirty, mode] = await Promise.all([
    request<string>('scene', 'query-current-scene').catch(() => ''),
    request<boolean>('scene', 'query-dirty').catch(() => false),
    request<string>('scene', 'query-scene-mode').catch(() => 'unknown'),
  ]);
  const asset = uuid ? await request<Record<string, unknown> | null>('asset-db', 'query-asset-info', uuid).catch(() => null) : null;
  return {
    uuid: uuid || null,
    name: asset?.name ?? null,
    url: asset?.url ?? null,
    dirty,
    mode,
  };
}

function pruneTree(
  node: Record<string, any>,
  depth: number,
  maxDepth: number,
  counter: { count: number; truncated: boolean },
  maxNodes: number,
): Record<string, unknown> | null {
  if (counter.count >= maxNodes) {
    counter.truncated = true;
    return null;
  }
  counter.count += 1;
  const result: Record<string, unknown> = {
    name: node.name,
    active: node.active,
    locked: node.locked,
    type: node.type,
    uuid: node.uuid,
    path: node.path,
    isScene: node.isScene,
  };
  if (Array.isArray(node.components) && node.components.length) {
    result.components = node.components.map((component: any) => ({
      type: component.type,
      value: component.value,
      isCustom: component.isCustom,
    }));
  }
  if (Array.isArray(node.children) && node.children.length) {
    if (depth <= 0) {
      result.children = [];
      result.childrenOmitted = node.children.length;
    } else {
      result.children = node.children
        .map((child: Record<string, any>) => pruneTree(child, depth - 1, maxDepth, counter, maxNodes))
        .filter(Boolean);
    }
  }
  return result;
}

export const sceneTools: ToolDef[] = [
  editorTool({
    name: 'scene_get_info',
    label: '读取场景信息',
    description: '读取当前场景的 uuid/名称/url、dirty、场景模式；不修改任何内容。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    skipGate: true,
    handler: async () => {
      const scene = await currentSceneInfo();
      return ok({ scene });
    },
  }),

  editorTool({
    name: 'scene_query_json',
    label: '读取场景 JSON',
    description: '读取当前场景序列化 JSON 字符串（可能很大，默认截断到 200KB）。用于结构分析/调试。',
    inputSchema: {
      type: 'object',
      properties: {
        maxBytes: { type: 'number', description: '最大字符数，默认 200000' },
      },
      additionalProperties: false,
    },
    risk: 'read',
    handler: async (args) => {
      const maxBytes = numArg(args, 'maxBytes') ?? 200_000;
      const json = await request<string>('scene', 'query-scene-json');
      const result = truncate(json ?? '', maxBytes);
      return ok({ json: result.text, truncated: result.truncated, bytes: (json ?? '').length });
    },
  }),

  editorTool({
    name: 'scene_query_node_tree',
    label: '读取节点树',
    description: '读取当前场景（或指定节点）的节点树；默认 depth=4、maxNodes=500，超出截断并标记。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '根节点 uuid；省略=当前场景' },
        depth: { type: 'number', description: '最大深度，默认 4' },
        maxNodes: { type: 'number', description: '最大节点数，默认 500' },
      },
      additionalProperties: false,
    },
    risk: 'read',
    handler: async (args) => {
      const uuid = uuidArg(args);
      const depth = Math.max(0, numArg(args, 'depth') ?? 4);
      const maxNodes = Math.max(1, numArg(args, 'maxNodes') ?? 500);
      const tree = await request<Record<string, any> | null>('scene', 'query-node-tree', uuid);
      if (!tree) return fail('NOT_FOUND', '节点树为空：场景可能未打开或 uuid 不存在。');
      const counter = { count: 0, truncated: false };
      const pruned = pruneTree(tree, depth, depth, counter, maxNodes);
      return ok({ tree: pruned, nodeCount: counter.count, truncated: counter.truncated });
    },
  }),

  editorTool({
    name: 'scene_open',
    label: '打开场景',
    description: '打开指定场景资源。当前场景有未保存修改时默认拒绝；确认可丢弃时传 force=true。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '场景资源 uuid' },
        force: { type: 'boolean', description: '有未保存修改时是否强制打开' },
      },
      required: ['uuid'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const uuid = strArg(args, 'uuid');
      if (!uuid) return fail('INVALID_ARGS', '缺少场景 uuid。');
      const dirty = await request<boolean>('scene', 'query-dirty').catch(() => false);
      if (dirty && args.force !== true) {
        return fail('EDITOR_BUSY', '当前场景有未保存修改，已拒绝打开。', '保存场景或传 force=true 后重试。');
      }
      await request('scene', 'open-scene', uuid);
      return ok({ opened: uuid });
    },
  }),

  editorTool({
    name: 'scene_save',
    label: '保存场景',
    description: '保存当前场景，返回保存后的场景 uuid。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'write',
    handler: async () => {
      const uuid = await request<string>('scene', 'save-scene');
      return ok({ saved: true, uuid: uuid ?? null });
    },
  }),

  editorTool({
    name: 'scene_new_empty',
    label: '新建空场景',
    description: '加载默认空场景。当前场景有未保存修改时默认拒绝；传 force=true 可强制。',
    inputSchema: {
      type: 'object',
      properties: { force: { type: 'boolean', description: '有未保存修改时是否强制新建' } },
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const dirty = await request<boolean>('scene', 'query-dirty').catch(() => false);
      if (dirty && args.force !== true) {
        return fail('EDITOR_BUSY', '当前场景有未保存修改，已拒绝新建。', '保存场景或传 force=true 后重试。');
      }
      await request('scene', 'load-empty-scene');
      return ok({ created: true });
    },
  }),

  editorTool({
    name: 'scene_soft_reload',
    label: '软重载场景',
    description: '软重载当前场景（重新加载场景数据，不重启编辑器）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'write',
    handler: async () => {
      await request('scene', 'soft-reload');
      return ok({ reloaded: true });
    },
  }),
];
