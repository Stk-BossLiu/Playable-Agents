import { request } from '../utils/ipc-editor';
import type { ToolDef } from '../bridge/schema';
import {
  boolArg,
  editorTool,
  fail,
  numArg,
  objectArg,
  ok,
  parseUuidList,
  strArg,
  uuidArg,
} from './common';

export const nodeTools: ToolDef[] = [
  editorTool({
    name: 'node_create',
    label: '创建节点',
    description: '在指定父节点/场景下创建节点；也可从 Prefab/SpriteFrame/Script 等资源创建。返回新节点 uuid。',
    inputSchema: {
      type: 'object',
      properties: {
        parent: { type: 'string', description: '父节点 uuid；省略=当前选中节点的父级/场景根' },
        name: { type: 'string', description: '节点名称' },
        nameIncrease: { type: 'boolean', description: '自动编号' },
        assetUuid: { type: 'string', description: '从资源创建时的资源 uuid' },
        type: { type: 'string', description: '资源类型，如 cc.Prefab/cc.SpriteFrame/cc.Script' },
        canvasRequired: { type: 'boolean', description: 'UI 节点自动创建 Canvas' },
        unlinkPrefab: { type: 'boolean', description: '实例化 Prefab 时取消关联' },
        keepWorldTransform: { type: 'boolean', description: '保持世界变换' },
        position: {
          type: 'object',
          description: '世界坐标（仅 assetUuid 路径）',
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
        },
        snapshot: { type: 'boolean', description: '自动包一层撤销，默认 true' },
      },
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const options: Record<string, unknown> = {};
      for (const key of ['parent', 'name', 'assetUuid', 'type']) {
        const value = strArg(args, key);
        if (value) options[key] = value;
      }
      for (const key of ['nameIncrease', 'canvasRequired', 'unlinkPrefab', 'keepWorldTransform', 'snapshot']) {
        const value = boolArg(args, key);
        if (value !== undefined) options[key] = value;
      }
      const position = objectArg(args, 'position');
      if (position) options.position = position;
      if (!options.name && !options.assetUuid) options.name = 'Node';
      if (options.snapshot === undefined) options.snapshot = true;
      const uuid = await request<string>('scene', 'create-node', options);
      return ok({ uuid });
    },
  }),

  editorTool({
    name: 'node_query',
    label: '查询节点',
    description: '查询节点完整 dump（含组件与属性）；不存在返回 null。',
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string', description: '节点 uuid' } },
      required: ['uuid'],
      additionalProperties: false,
    },
    risk: 'read',
    handler: async (args) => {
      const uuid = uuidArg(args);
      if (!uuid) return fail('INVALID_ARGS', '缺少节点 uuid。');
      const dump = await request<Record<string, unknown> | null>('scene', 'query-node', uuid);
      return ok({ node: dump });
    },
  }),

  editorTool({
    name: 'node_delete',
    label: '删除节点',
    description: '删除一个或多个节点。这是破坏性操作，默认需要用户审批。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '节点 uuid' },
        uuids: { type: 'array', items: { type: 'string' }, description: '多个节点 uuid' },
        keepWorldTransform: { type: 'boolean', description: '保持子节点世界变换' },
      },
      additionalProperties: false,
    },
    risk: 'destroy',
    approvalSummary: (args) => `删除节点：${parseUuidList(args, 'uuid', 'uuids').join(', ') || '(未指定)'}`,
    handler: async (args) => {
      const uuids = parseUuidList(args, 'uuid', 'uuids');
      if (!uuids.length) return fail('INVALID_ARGS', '缺少节点 uuid。');
      const result = await request('scene', 'remove-node', {
        uuid: uuids.length === 1 ? uuids[0] : uuids,
        ...(boolArg(args, 'keepWorldTransform') !== undefined
          ? { keepWorldTransform: boolArg(args, 'keepWorldTransform') }
          : {}),
      });
      return ok({ removed: uuids, result });
    },
  }),

  editorTool({
    name: 'node_set_parent',
    label: '设置父节点',
    description: '把一个或多个节点移动到新的父节点下。',
    inputSchema: {
      type: 'object',
      properties: {
        parent: { type: 'string', description: '新父节点 uuid' },
        uuids: { type: 'array', items: { type: 'string' }, description: '要移动的节点 uuid 列表' },
        uuid: { type: 'string', description: '单个节点 uuid（uuids 的别名）' },
        keepWorldTransform: { type: 'boolean', description: '保持世界变换' },
      },
      required: ['parent'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const parent = strArg(args, 'parent');
      const uuids = parseUuidList(args, 'uuid', 'uuids');
      if (!parent || !uuids.length) return fail('INVALID_ARGS', '缺少 parent 或节点 uuid。');
      const moved = await request<string[]>('scene', 'set-parent', {
        parent,
        uuids,
        ...(boolArg(args, 'keepWorldTransform') !== undefined
          ? { keepWorldTransform: boolArg(args, 'keepWorldTransform') }
          : {}),
      });
      return ok({ moved });
    },
  }),

  editorTool({
    name: 'node_duplicate',
    label: '复制节点',
    description: '复制节点（可多个），返回新节点 uuid 列表。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '节点 uuid' },
        uuids: { type: 'array', items: { type: 'string' }, description: '多个节点 uuid' },
      },
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const uuids = parseUuidList(args, 'uuid', 'uuids');
      if (!uuids.length) return fail('INVALID_ARGS', '缺少节点 uuid。');
      const created = await request<string[]>('scene', 'duplicate-node', uuids.length === 1 ? uuids[0] : uuids);
      return ok({ created });
    },
  }),

  editorTool({
    name: 'node_paste',
    label: '粘贴节点',
    description: '把剪贴板中的节点粘贴到目标节点下。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标父节点 uuid' },
        uuids: { type: 'array', items: { type: 'string' }, description: '可选的源节点 uuid' },
        keepWorldTransform: { type: 'boolean' },
        pasteAsChild: { type: 'boolean' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const target = strArg(args, 'target');
      if (!target) return fail('INVALID_ARGS', '缺少目标节点 uuid。');
      const sourceUuids = Array.isArray(args.uuids)
        ? args.uuids.filter((item): item is string => typeof item === 'string')
        : [];
      // scene 的 paste-node 依赖 copy-node 写入的 stash；显式给 uuids 时先复制一次。
      if (sourceUuids.length) {
        await request('scene', 'copy-node', sourceUuids);
      }
      const created = await request<string[]>('scene', 'paste-node', {
        target,
        ...(sourceUuids.length ? { uuids: sourceUuids } : {}),
        ...(boolArg(args, 'keepWorldTransform') !== undefined
          ? { keepWorldTransform: boolArg(args, 'keepWorldTransform') }
          : {}),
        ...(boolArg(args, 'pasteAsChild') !== undefined ? { pasteAsChild: boolArg(args, 'pasteAsChild') } : {}),
      });
      return ok({ created: created ?? [] });
    },
  }),

  editorTool({
    name: 'node_reset',
    label: '重置节点变换',
    description: '重置节点的 position/rotation/scale/mobility。',
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string', description: '节点 uuid' } },
      required: ['uuid'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const uuid = uuidArg(args);
      if (!uuid) return fail('INVALID_ARGS', '缺少节点 uuid。');
      const result = await request<boolean>('scene', 'reset-node', { uuid });
      return ok({ reset: result });
    },
  }),

  editorTool({
    name: 'node_lock',
    label: '锁定/解锁节点',
    description: '锁定或解锁节点（可包含子节点）。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '节点 uuid' },
        uuids: { type: 'array', items: { type: 'string' }, description: '多个节点 uuid' },
        lock: { type: 'boolean', description: 'true=锁定，false=解锁' },
        includeChildren: { type: 'boolean', description: '包含子节点' },
      },
      required: ['lock'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const uuids = parseUuidList(args, 'uuid', 'uuids');
      const lock = boolArg(args, 'lock');
      if (!uuids.length || lock === undefined) return fail('INVALID_ARGS', '缺少节点 uuid 或 lock。');
      await request('scene', 'change-node-lock', uuids.length === 1 ? uuids[0] : uuids, lock, Boolean(args.includeChildren));
      return ok({ locked: lock, uuids });
    },
  }),

  editorTool({
    name: 'node_focus',
    label: '聚焦节点',
    description: '把场景相机聚焦到指定节点（不改数据）。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '节点 uuid' },
        uuids: { type: 'array', items: { type: 'string' }, description: '多个节点 uuid' },
      },
      additionalProperties: false,
    },
    risk: 'read',
    handler: async (args) => {
      const uuids = parseUuidList(args, 'uuid', 'uuids');
      if (!uuids.length) return fail('INVALID_ARGS', '缺少节点 uuid。');
      // focus-camera 内部按数组处理，单节点也必须包成数组。
      await request('scene', 'focus-camera', uuids);
      return ok({ focused: uuids });
    },
  }),

  editorTool({
    name: 'node_rename',
    label: '重命名节点',
    description: '重命名节点，自动包一层撤销录制。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '节点 uuid' },
        name: { type: 'string', description: '新名称' },
      },
      required: ['uuid', 'name'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const uuid = uuidArg(args);
      const name = strArg(args, 'name');
      if (!uuid || !name) return fail('INVALID_ARGS', '缺少节点 uuid 或 name。');
      const id = await request<string>('scene', 'begin-recording', uuid, { auto: false });
      const changed = await request<boolean>('scene', 'set-property', {
        uuid,
        path: 'name',
        dump: { type: 'string', value: name },
      });
      if (changed) await request('scene', 'end-recording', id);
      else await request('scene', 'cancel-recording', id);
      return ok({ renamed: changed, name });
    },
  }),

  editorTool({
    name: 'node_move_in_parent',
    label: '调整节点顺序',
    description: '在父节点的 children 数组中前后移动节点。target 可指定父节点，省略则用节点的实际父级。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '要移动的节点 uuid' },
        target: { type: 'string', description: '父节点 uuid；省略则自动读取节点父级' },
        offset: { type: 'number', description: '移动偏移（正=向后，负=向前，默认 1）' },
      },
      required: ['uuid'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const uuid = uuidArg(args);
      if (!uuid) return fail('INVALID_ARGS', '缺少节点 uuid。');
      const dump = await request<Record<string, any> | null>('scene', 'query-node', uuid);
      if (!dump) return fail('NOT_FOUND', '节点不存在。');
      const parentUuid = strArg(args, 'target') || (dump.parent?.value?.uuid as string | undefined);
      if (!parentUuid) return fail('INVALID_ARGS', '无法确定父节点，请传 target。');
      const parent = await request<Record<string, any> | null>('scene', 'query-node', parentUuid);
      const children = Array.isArray(parent?.children) ? parent?.children : [];
      const index = children.findIndex((child: any) => child?.value?.uuid === uuid);
      if (index < 0) return fail('NOT_FOUND', '节点不在指定父级的 children 中。');
      const offset = numArg(args, 'offset') ?? 1;
      if (index + offset < 0 || index + offset >= children.length) {
        return ok({ moved: false, index, offset, reason: 'out-of-range' });
      }
      const result = await request<boolean>('scene', 'move-array-element', {
        uuid: parentUuid,
        path: 'children',
        target: index,
        offset,
      });
      return ok({ moved: Boolean(result), index, offset, parent: parentUuid });
    },
  }),
];
