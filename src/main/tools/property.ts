import { request } from '../utils/ipc-editor';
import type { ToolDef } from '../bridge/schema';
import { boolArg, editorTool, fail, objectArg, ok, parseUuidList, strArg, toDump, uuidArg } from './common';

export const propertyTools: ToolDef[] = [
  editorTool({
    name: 'property_set',
    label: '设置属性',
    description:
      '设置节点/组件属性。path 用 dump 名（position/rotation/scale/name/__comps__.N.prop）；value 自动构造 dump，也可传 dump。默认包撤销录制。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '节点 uuid' },
        path: { type: 'string', description: '属性路径' },
        value: { description: '属性值' },
        type: {
          type: 'string',
          description: '值类型：string/number/boolean/vec3/enum/node/cc.Vec3 等',
        },
        dump: { type: 'object', description: '完整 dump（优先于 value）' },
        record: { type: 'boolean', description: '是否包撤销录制，默认 true' },
      },
      required: ['uuid', 'path'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const uuid = uuidArg(args);
      const path = strArg(args, 'path');
      if (!uuid || !path) return fail('INVALID_ARGS', '缺少 uuid 或 path。');
      const dump = objectArg(args, 'dump') ?? toDump(args.value, strArg(args, 'type'));
      if (!dump) return fail('INVALID_ARGS', '缺少 value 或 dump。');
      const record = boolArg(args, 'record') !== false;
      const recordingId = record ? await request<string>('scene', 'begin-recording', uuid, { auto: false }) : null;
      const changed = await request<boolean>('scene', 'set-property', { uuid, path, dump });
      if (recordingId) {
        if (changed) await request('scene', 'end-recording', recordingId);
        else await request('scene', 'cancel-recording', recordingId);
      }
      return ok({ changed, path, recordingId });
    },
  }),

  editorTool({
    name: 'property_reset',
    label: '重置属性',
    description: '把节点/组件属性重置为默认值。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '节点 uuid' },
        path: { type: 'string', description: '属性路径' },
      },
      required: ['uuid', 'path'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const uuid = uuidArg(args);
      const path = strArg(args, 'path');
      if (!uuid || !path) return fail('INVALID_ARGS', '缺少 uuid 或 path。');
      const reset = await request<boolean>('scene', 'reset-property', { uuid, path });
      return ok({ reset, path });
    },
  }),

  editorTool({
    name: 'property_preview',
    label: '预览属性',
    description: '临时预览属性修改（不产生撤销项）；配合 property_cancel_preview 取消。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '节点 uuid' },
        path: { type: 'string', description: '属性路径' },
        value: { description: '属性值' },
        type: { type: 'string', description: '值类型' },
        dump: { type: 'object', description: '完整 dump' },
      },
      required: ['uuid', 'path'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const uuid = uuidArg(args);
      const path = strArg(args, 'path');
      const dump = objectArg(args, 'dump') ?? toDump(args.value, strArg(args, 'type'));
      if (!uuid || !path || !dump) return fail('INVALID_ARGS', '缺少 uuid/path/value。');
      const previewed = await request<boolean>('scene', 'preview-set-property', { uuid, path, dump });
      return ok({ previewed: Boolean(previewed), path });
    },
  }),

  editorTool({
    name: 'property_cancel_preview',
    label: '取消属性预览',
    description: '取消 property_preview 的临时修改。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '节点 uuid' },
        path: { type: 'string', description: '属性路径' },
      },
      required: ['uuid', 'path'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const uuid = uuidArg(args);
      const path = strArg(args, 'path');
      if (!uuid || !path) return fail('INVALID_ARGS', '缺少 uuid 或 path。');
      const cancelled = await request<boolean>('scene', 'cancel-preview-set-property', { uuid, path });
      return ok({ cancelled: Boolean(cancelled), path });
    },
  }),

  editorTool({
    name: 'recording_begin',
    label: '开始撤销录制',
    description: '开始批量操作录制；返回 recordingId，供 recording_end/cancel 使用。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '节点 uuid' },
        uuids: { type: 'array', items: { type: 'string' }, description: '多个节点 uuid' },
        tag: { type: 'string', description: '录制标签' },
        auto: { type: 'boolean', description: 'auto 模式，默认 false' },
      },
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const uuids = parseUuidList(args, 'uuid', 'uuids');
      if (!uuids.length) return fail('INVALID_ARGS', '缺少节点 uuid。');
      const id = await request<string>('scene', 'begin-recording', uuids.length === 1 ? uuids[0] : uuids, {
        auto: boolArg(args, 'auto') ?? false,
        ...(strArg(args, 'tag') ? { tag: strArg(args, 'tag') } : {}),
      });
      return ok({ recordingId: id });
    },
  }),

  editorTool({
    name: 'recording_end',
    label: '结束撤销录制',
    description: '结束录制并生成一个撤销项；返回 false 表示无变化被丢弃。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'recordingId' } },
      required: ['id'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const id = strArg(args, 'id', 'recordingId');
      if (!id) return fail('INVALID_ARGS', '缺少 recordingId。');
      const ended = await request<boolean>('scene', 'end-recording', id);
      return ok({ ended });
    },
  }),

  editorTool({
    name: 'recording_cancel',
    label: '取消撤销录制',
    description: '取消录制并丢弃期间的修改。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'recordingId' } },
      required: ['id'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const id = strArg(args, 'id', 'recordingId');
      if (!id) return fail('INVALID_ARGS', '缺少 recordingId。');
      const cancelled = await request<boolean>('scene', 'cancel-recording', id);
      return ok({ cancelled });
    },
  }),

  editorTool({
    name: 'undo',
    label: '撤销',
    description: '撤销当前场景的上一次操作。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'write',
    handler: async () => {
      await request('scene', 'undo');
      return ok({ undone: true });
    },
  }),

  editorTool({
    name: 'redo',
    label: '重做',
    description: '重做当前场景的上一次撤销。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'write',
    handler: async () => {
      await request('scene', 'redo');
      return ok({ redone: true });
    },
  }),
];
