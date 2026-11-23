import { request } from '../utils/ipc-editor';
import type { ToolDef } from '../bridge/schema';
import {
  boolArg,
  componentIndexFromDump,
  editorTool,
  fail,
  objectArg,
  ok,
  strArg,
  toDump,
  uuidArg,
} from './common';

async function queryNode(uuid: string): Promise<Record<string, any> | null> {
  return request<Record<string, any> | null>('scene', 'query-node', uuid);
}

export const componentTools: ToolDef[] = [
  editorTool({
    name: 'component_add',
    label: '添加组件',
    description: '向节点添加组件（如 cc.Sprite、cc.BoxCollider、自定义脚本组件名/cid）。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '节点 uuid' },
        component: { type: 'string', description: '组件类型/名称/cid，如 cc.Sprite' },
      },
      required: ['uuid', 'component'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const uuid = uuidArg(args);
      const component = strArg(args, 'component', 'componentType');
      if (!uuid || !component) return fail('INVALID_ARGS', '缺少节点 uuid 或 component。');
      await request('scene', 'create-component', { uuid, component });
      const dump = await queryNode(uuid);
      return ok({
        added: true,
        components:
          dump?.__comps__?.map((item: any) => ({
            type: item?.type ?? null,
            name: item?.value?.name?.value ?? item?.value?.name ?? null,
            uuid: item?.value?.uuid?.value ?? item?.value?.uuid ?? null,
          })) ?? [],
      });
    },
  }),

  editorTool({
    name: 'component_remove',
    label: '移除组件',
    description: '移除指定组件。破坏性操作，默认需要用户审批。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '组件 uuid（也接受 componentUuid）' },
        componentUuid: { type: 'string', description: '组件 uuid 别名' },
      },
      additionalProperties: false,
    },
    risk: 'destroy',
    approvalSummary: (args) => `移除组件：${strArg(args, 'uuid', 'componentUuid') ?? '(未指定)'}`,
    handler: async (args) => {
      const uuid = uuidArg(args) ?? strArg(args, 'componentUuid');
      if (!uuid) return fail('INVALID_ARGS', '缺少组件 uuid。');
      await request('scene', 'remove-component', { uuid });
      return ok({ removed: true, uuid });
    },
  }),

  editorTool({
    name: 'component_reset',
    label: '重置组件',
    description: '重置组件属性到默认值。',
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string', description: '组件 uuid' } },
      required: ['uuid'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const uuid = uuidArg(args);
      if (!uuid) return fail('INVALID_ARGS', '缺少组件 uuid。');
      const reset = await request<boolean>('scene', 'reset-component', { uuid });
      return ok({ reset });
    },
  }),

  editorTool({
    name: 'component_query',
    label: '查询组件',
    description: '查询组件完整 dump。',
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string', description: '组件 uuid' } },
      required: ['uuid'],
      additionalProperties: false,
    },
    risk: 'read',
    handler: async (args) => {
      const uuid = uuidArg(args);
      if (!uuid) return fail('INVALID_ARGS', '缺少组件 uuid。');
      const component = await request<Record<string, unknown> | null>('scene', 'query-component', uuid);
      return ok({ component });
    },
  }),

  editorTool({
    name: 'component_list',
    label: '列出节点组件',
    description: '列出节点上的组件（名称/类型/uuid/cid）与可调用方法。',
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
      const dump = await queryNode(uuid);
      if (!dump) return fail('NOT_FOUND', '节点不存在。');
      const components = Array.isArray(dump.__comps__)
        ? dump.__comps__.map((comp: any, index: number) => ({
            index,
            uuid: comp?.value?.uuid?.value ?? comp?.value?.uuid ?? null,
            name: comp?.value?.name?.value ?? comp?.value?.name ?? null,
            type: comp?.type ?? null,
            cid: comp?.cid ?? null,
            enabled: comp?.value?.enabled?.value ?? comp?.value?.enabled ?? null,
          }))
        : [];
      const methods = await request<Record<string, string[]>>('scene', 'query-component-function-of-node', uuid).catch(
        () => ({}),
      );
      return ok({ components, methods });
    },
  }),

  editorTool({
    name: 'component_set_property',
    label: '设置组件属性',
    description:
      '设置节点上某个组件的属性。component 可为组件索引/uuid/名称/cid；property 为属性名；value 自动构造 dump，也可传 dump。',
    inputSchema: {
      type: 'object',
      properties: {
        nodeUuid: { type: 'string', description: '节点 uuid' },
        uuid: { type: 'string', description: '节点 uuid 别名' },
        component: { type: 'string', description: '组件索引/uuid/名称/cid' },
        property: { type: 'string', description: '属性名' },
        value: { description: '属性值' },
        type: { type: 'string', description: '值类型（string/number/boolean/vec3/enum/node/cc.Vec3）' },
        dump: { type: 'object', description: '完整 dump（优先于 value）' },
        record: { type: 'boolean', description: '是否包撤销录制，默认 true' },
      },
      required: ['property'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const nodeUuid = uuidArg(args) ?? strArg(args, 'nodeUuid');
      const property = strArg(args, 'property');
      if (!nodeUuid || !property) return fail('INVALID_ARGS', '缺少节点 uuid 或 property。');
      const dump = await queryNode(nodeUuid);
      if (!dump) return fail('NOT_FOUND', '节点不存在。');
      const index = componentIndexFromDump(dump, args.component as string | number | undefined);
      if (index < 0) return fail('NOT_FOUND', `找不到组件：${String(args.component ?? '')}`);
      const propertyDump = objectArg(args, 'dump') ?? toDump(args.value, strArg(args, 'type'));
      if (!propertyDump) return fail('INVALID_ARGS', '缺少 value 或 dump。');
      const path = `__comps__.${index}.${property}`;
      const record = boolArg(args, 'record') !== false;
      const recordingId = record ? await request<string>('scene', 'begin-recording', nodeUuid, { auto: false }) : null;
      const changed = await request<boolean>('scene', 'set-property', { uuid: nodeUuid, path, dump: propertyDump });
      if (recordingId) {
        if (changed) await request('scene', 'end-recording', recordingId);
        else await request('scene', 'cancel-recording', recordingId);
      }
      return ok({ changed, path });
    },
  }),

  editorTool({
    name: 'component_execute_method',
    label: '执行组件方法',
    description: '在编辑器内执行节点组件的方法（谨慎使用，可能修改场景状态）。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '组件 uuid' },
        name: { type: 'string', description: '方法名' },
        args: { type: 'array', items: {}, description: '方法参数' },
      },
      required: ['uuid', 'name'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (inputs) => {
      const uuid = uuidArg(inputs);
      const name = strArg(inputs, 'name', 'method');
      if (!uuid || !name) return fail('INVALID_ARGS', '缺少组件 uuid 或方法名。');
      const methodArgs = Array.isArray(inputs.args) ? inputs.args : [];
      const result = await request('scene', 'execute-component-method', { uuid, name, args: methodArgs });
      return ok({ result });
    },
  }),
];
