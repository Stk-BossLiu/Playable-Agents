import { request } from '../utils/ipc-editor';
import type { ToolDef } from '../bridge/schema';
import { boolArg, editorTool, fail, ok, strArg } from './common';

function assetTarget(args: Record<string, unknown>): string | undefined {
  return strArg(args, 'url', 'path', 'uuid', 'asset');
}

function scriptTemplate(className: string, base: string): string {
  return `import { _decorator, Component, Node } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('${className}')
export class ${className} extends ${base} {
    @property(Node)
    target: Node | null = null;

    start() {
        // start
    }

    update(deltaTime: number) {
        // update
    }
}
`;
}

export const assetTools: ToolDef[] = [
  editorTool({
    name: 'asset_query_info',
    label: '查询资源信息',
    description: '按 uuid/url/路径查询单个资源信息（可含 meta/depends/mtime）。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        url: { type: 'string' },
        path: { type: 'string' },
        dataKeys: { type: 'array', items: { type: 'string' }, description: 'meta/depends/mtime 等' },
      },
      additionalProperties: false,
    },
    risk: 'read',
    handler: async (args) => {
      const target = assetTarget(args);
      if (!target) return fail('INVALID_ARGS', '缺少 uuid/url/path。');
      const dataKeys = Array.isArray(args.dataKeys) ? args.dataKeys : undefined;
      const info = await request<Record<string, unknown> | null>('asset-db', 'query-asset-info', target, dataKeys);
      return ok({ asset: info });
    },
  }),

  editorTool({
    name: 'asset_query_assets',
    label: '批量查询资源',
    description: '按 ccType/pattern/importer/isBundle/extname/userData 查询资源列表。',
    inputSchema: {
      type: 'object',
      properties: {
        ccType: { type: 'string', description: '如 cc.Prefab、cc.SpriteFrame' },
        pattern: { type: 'string', description: 'glob 模式' },
        importer: { type: 'string' },
        isBundle: { type: 'boolean' },
        extname: { type: 'string' },
        userData: { type: 'object' },
      },
      additionalProperties: false,
    },
    risk: 'read',
    handler: async (args) => {
      const options: Record<string, unknown> = {};
      for (const key of ['ccType', 'pattern', 'importer', 'extname']) {
        const value = strArg(args, key);
        if (value) options[key] = value;
      }
      for (const key of ['isBundle']) {
        const value = boolArg(args, key);
        if (value !== undefined) options[key] = value;
      }
      if (args.userData && typeof args.userData === 'object') options.userData = args.userData;
      const assets = await request<unknown[]>('asset-db', 'query-assets', options);
      return ok({ assets: assets ?? [], count: assets?.length ?? 0 });
    },
  }),

  editorTool({
    name: 'asset_query_uuid',
    label: '查询资源 uuid',
    description: '按 db:// url 或磁盘路径查询资源 uuid。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, path: { type: 'string' } },
      additionalProperties: false,
    },
    risk: 'read',
    handler: async (args) => {
      const target = strArg(args, 'url', 'path');
      if (!target) return fail('INVALID_ARGS', '缺少 url/path。');
      const uuid = await request<string>('asset-db', 'query-uuid', target);
      return ok({ uuid: uuid || null });
    },
  }),

  editorTool({
    name: 'asset_query_path',
    label: '查询资源路径',
    description: '按 uuid/url 查询资源绝对路径。',
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string' }, url: { type: 'string' } },
      additionalProperties: false,
    },
    risk: 'read',
    handler: async (args) => {
      const target = strArg(args, 'uuid', 'url');
      if (!target) return fail('INVALID_ARGS', '缺少 uuid/url。');
      const path = await request<string | null>('asset-db', 'query-path', target);
      return ok({ path });
    },
  }),

  editorTool({
    name: 'asset_create',
    label: '创建资源',
    description:
      '在 asset-db 中创建资源（文本/脚本/预制体等）。target 为 db://assets/...；可传 content 或 handler/ccType/template。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'db://assets/... 目标 url' },
        target: { type: 'string', description: 'url 别名' },
        content: { type: 'string', description: '资源内容（文本）' },
        overwrite: { type: 'boolean' },
        rename: { type: 'boolean' },
        uuid: { type: 'string' },
        handler: { type: 'string' },
        ccType: { type: 'string' },
        template: { type: 'string' },
      },
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const target = assetTarget(args);
      if (!target) return fail('INVALID_ARGS', '缺少目标 url。');
      const options: Record<string, unknown> = {
        target,
        ...(typeof args.content === 'string' ? { content: args.content } : {}),
        ...(boolArg(args, 'overwrite') !== undefined ? { overwrite: boolArg(args, 'overwrite') } : {}),
        ...(boolArg(args, 'rename') !== undefined ? { rename: boolArg(args, 'rename') } : {}),
        ...(strArg(args, 'uuid') ? { uuid: strArg(args, 'uuid') } : {}),
        ...(strArg(args, 'handler') ? { handler: strArg(args, 'handler') } : {}),
        ...(strArg(args, 'ccType') ? { ccType: strArg(args, 'ccType') } : {}),
        ...(strArg(args, 'template') ? { template: strArg(args, 'template') } : {}),
      };
      const info = await request<Record<string, unknown> | null>('asset-db', 'new-asset', options);
      return ok({ asset: info });
    },
  }),

  editorTool({
    name: 'asset_save',
    label: '保存资源',
    description: '保存资源内容（文本或 Buffer）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'db:// url 或 uuid' },
        uuid: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const target = assetTarget(args);
      if (!target) return fail('INVALID_ARGS', '缺少 url/uuid。');
      const info = await request<Record<string, unknown> | null>('asset-db', 'save-asset', target, String(args.content ?? ''));
      return ok({ asset: info });
    },
  }),

  editorTool({
    name: 'asset_delete',
    label: '删除资源',
    description: '删除资源（按 url/uuid/绝对路径）。破坏性操作，默认需要用户审批。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        uuid: { type: 'string' },
        path: { type: 'string' },
      },
      additionalProperties: false,
    },
    risk: 'destroy',
    approvalSummary: (args) => `删除资源：${assetTarget(args) ?? '(未指定)'}`,
    handler: async (args) => {
      const target = assetTarget(args);
      if (!target) return fail('INVALID_ARGS', '缺少 url/uuid/path。');
      const info = await request<Record<string, unknown> | null>('asset-db', 'delete-asset', target);
      return ok({ deleted: target, asset: info });
    },
  }),

  editorTool({
    name: 'asset_move',
    label: '移动资源',
    description: '移动/重命名资源。返回 boolean（asset-db move-asset 的返回不是 AssetInfo）。',
    inputSchema: {
      type: 'object',
      properties: {
        srcUrl: { type: 'string', description: '源 db:// url' },
        destUrl: { type: 'string', description: '目标 db:// url' },
        overwrite: { type: 'boolean' },
      },
      required: ['srcUrl', 'destUrl'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const srcUrl = strArg(args, 'srcUrl', 'from', 'source');
      const destUrl = strArg(args, 'destUrl', 'to', 'target');
      if (!srcUrl || !destUrl) return fail('INVALID_ARGS', '缺少 srcUrl/destUrl。');
      await request('asset-db', 'move-asset', srcUrl, destUrl, {
        ...(boolArg(args, 'overwrite') !== undefined ? { overwrite: boolArg(args, 'overwrite') } : {}),
      });
      // move-asset 不返回 AssetInfo，用目标查询确认移动结果。
      const info = await request<Record<string, unknown> | null>('asset-db', 'query-asset-info', destUrl).catch(
        () => null,
      );
      return ok({ moved: Boolean(info), srcUrl, destUrl, asset: info });
    },
  }),

  editorTool({
    name: 'asset_copy',
    label: '复制资源',
    description: '复制资源到目标 url。',
    inputSchema: {
      type: 'object',
      properties: {
        srcUrl: { type: 'string' },
        destUrl: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
      required: ['srcUrl', 'destUrl'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const srcUrl = strArg(args, 'srcUrl', 'from', 'source');
      const destUrl = strArg(args, 'destUrl', 'to', 'target');
      if (!srcUrl || !destUrl) return fail('INVALID_ARGS', '缺少 srcUrl/destUrl。');
      const info = await request<Record<string, unknown> | null>('asset-db', 'copy-asset', srcUrl, destUrl, {
        ...(boolArg(args, 'overwrite') !== undefined ? { overwrite: boolArg(args, 'overwrite') } : {}),
      });
      return ok({ asset: info });
    },
  }),

  editorTool({
    name: 'asset_refresh',
    label: '刷新资源',
    description: '刷新指定资源（url/路径/uuid），让 asset-db 重新导入。',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'url/路径/uuid' } },
      required: ['target'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const target = strArg(args, 'target', 'url', 'path', 'uuid');
      if (!target) return fail('INVALID_ARGS', '缺少 target。');
      await request('asset-db', 'refresh-asset', target);
      return ok({ refreshed: target });
    },
  }),

  editorTool({
    name: 'asset_reimport',
    label: '重新导入资源',
    description: '强制重新导入资源。',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'uuid/url' } },
      required: ['target'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const target = strArg(args, 'target', 'uuid', 'url');
      if (!target) return fail('INVALID_ARGS', '缺少 target。');
      await request('asset-db', 'reimport-asset', target);
      return ok({ reimported: target });
    },
  }),

  editorTool({
    name: 'asset_create_script',
    label: '创建 TS 脚本',
    description: '创建 TypeScript 组件脚本（默认 Component 模板）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'db://assets/.../Foo.ts' },
        className: { type: 'string', description: '类名，默认从文件名推断' },
        base: { type: 'string', description: '基类，默认 Component' },
        content: { type: 'string', description: '自定义脚本内容（优先）' },
        overwrite: { type: 'boolean' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    risk: 'write',
    handler: async (args) => {
      const url = strArg(args, 'url', 'target');
      if (!url) return fail('INVALID_ARGS', '缺少脚本 url。');
      const fileName = url.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'NewComponent';
      const className = strArg(args, 'className') ?? (fileName.replace(/[^A-Za-z0-9_]/g, '') || 'NewComponent');
      const base = strArg(args, 'base') ?? 'Component';
      const content = typeof args.content === 'string' ? args.content : scriptTemplate(className, base);
      const info = await request<Record<string, unknown> | null>('asset-db', 'new-asset', {
        target: url,
        content,
        ...(boolArg(args, 'overwrite') !== undefined ? { overwrite: boolArg(args, 'overwrite') } : {}),
      });
      return ok({ asset: info, className, url });
    },
  }),

  editorTool({
    name: 'asset_open',
    label: '打开资源',
    description: '在编辑器中打开资源（脚本/场景/预制体等）。',
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string' }, url: { type: 'string' } },
      additionalProperties: false,
    },
    risk: 'read',
    handler: async (args) => {
      const target = assetTarget(args);
      if (!target) return fail('INVALID_ARGS', '缺少 uuid/url。');
      await request('asset-db', 'open-asset', target);
      return ok({ opened: target });
    },
  }),
];
