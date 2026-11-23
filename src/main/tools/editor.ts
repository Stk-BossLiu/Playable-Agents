import { PACKAGE_NAME } from '../../shared/protocol';
import { requestWithTimeout } from '../utils/ipc-editor';
import { defineTool, type ToolContext, type ToolDef } from '../bridge/schema';
import { ok } from '../bridge/result';
import { boolArg, fail, numArg, objectArg, parseUuidList, strArg } from './common';

interface QueryResult<T> {
  value: T;
  error?: string;
}

async function query<T>(target: string, message: string, fallback: T, ...args: unknown[]): Promise<QueryResult<T>> {
  try {
    const value = await requestWithTimeout<T>(target, message, args, 15_000);
    return { value: value ?? fallback };
  } catch (error) {
    return { value: fallback, error: error instanceof Error ? error.message : String(error) };
  }
}

export const editorTools: ToolDef[] = [
  defineTool({
    name: 'editor_get_state',
    label: '读取编辑器状态',
    description:
      '读取 Cocos Creator 当前就绪状态：场景、asset-db、编译、预览、选中节点与工程信息。' +
      '修改场景/资源前先调用；advice.ready_for_tools=false 时按 retry_after_ms 稍后重试。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    risk: 'read',
    async handler(_args, ctx: ToolContext) {
      const [
        sceneReady,
        assetReady,
        programmingReady,
        sceneUuid,
        dirty,
        sceneMode,
        previewUrl,
      ] = await Promise.all([
        query<boolean>('scene', 'query-is-ready', false),
        query<boolean>('asset-db', 'query-ready', false),
        query<boolean>('programming', 'packer-driver/ready', false, 'editor'),
        query<string>('scene', 'query-current-scene', ''),
        query<boolean>('scene', 'query-dirty', false),
        query<string>('scene', 'query-scene-mode', 'unknown'),
        query<string>('preview', 'query-preview-url', ''),
      ]);

      const uuid = sceneUuid.value || null;
      const sceneName = uuid
        ? (await query<{ name?: string; url?: string } | null>('asset-db', 'query-asset-info', null, uuid)).value
        : null;

      let selected: string[] = [];
      try {
        selected = Editor.Selection.getSelected('node') ?? [];
      } catch {
        selected = [];
      }

      const blockingReasons: string[] = [];
      if (!sceneReady.value) blockingReasons.push('scene 未就绪');
      if (!assetReady.value) blockingReasons.push('asset-db 未就绪');

      return ok({
        schema_version: '1',
        editor: {
          name: PACKAGE_NAME,
          version: Editor.App.version,
          projectPath: Editor.Project.path,
        },
        scene: {
          ready: sceneReady.value,
          dirty: dirty.value,
          uuid,
          name: sceneName?.name ?? null,
          url: sceneName?.url ?? null,
          mode: sceneMode.value,
        },
        asset_db: { ready: assetReady.value },
        programming: { ready: programmingReady.value },
        preview: { url: previewUrl.value || null },
        selection: { type: 'node', uuids: selected },
        bridge: { url: ctx.bridgeUrl, toolCount: ctx.toolCount },
        advice: {
          ready_for_tools: sceneReady.value && assetReady.value,
          blocking_reasons: blockingReasons,
          retry_after_ms: blockingReasons.length ? 800 : 0,
        },
        errors: {
          scene: sceneReady.error,
          assetDb: assetReady.error,
          programming: programmingReady.error,
          preview: previewUrl.error,
        },
      });
    },
  }),

  defineTool({
    name: 'editor_select_nodes',
    label: '选中节点',
    description: '在场景/层级面板中选中一个或多个节点（不修改场景数据）。',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: '节点 uuid' },
        uuids: { type: 'array', items: { type: 'string' }, description: '多个节点 uuid' },
      },
      additionalProperties: false,
    },
    risk: 'read',
    skipGate: true,
    async handler(args) {
      const uuids = parseUuidList(args, 'uuid', 'uuids');
      if (!uuids.length) return fail('INVALID_ARGS', '缺少节点 uuid。');
      Editor.Selection.select('node', uuids.length === 1 ? uuids[0] : uuids);
      return ok({ selected: uuids });
    },
  }),

  defineTool({
    name: 'editor_get_selection',
    label: '读取选中',
    description: '读取当前选中节点/资源。',
    inputSchema: {
      type: 'object',
      properties: { type: { type: 'string', description: 'node/asset，默认 node' } },
      additionalProperties: false,
    },
    risk: 'read',
    skipGate: true,
    async handler(args) {
      const type = strArg(args, 'type') ?? 'node';
      const selected = Editor.Selection.getSelected(type) ?? [];
      const last = Editor.Selection.getLastSelected(type) || null;
      return ok({ type, selected, last });
    },
  }),

  defineTool({
    name: 'editor_clear_selection',
    label: '清空选中',
    description: '清空某类型（默认 node）的选中状态。',
    inputSchema: {
      type: 'object',
      properties: { type: { type: 'string', description: 'node/asset，默认 node' } },
      additionalProperties: false,
    },
    risk: 'read',
    skipGate: true,
    async handler(args) {
      const type = strArg(args, 'type') ?? 'node';
      Editor.Selection.clear(type);
      return ok({ cleared: type });
    },
  }),

  defineTool({
    name: 'editor_select_asset',
    label: '选中资源',
    description: '在资源管理器中选中资源。',
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string', description: '资源 uuid' } },
      required: ['uuid'],
      additionalProperties: false,
    },
    risk: 'read',
    skipGate: true,
    async handler(args) {
      const uuid = strArg(args, 'uuid');
      if (!uuid) return fail('INVALID_ARGS', '缺少资源 uuid。');
      Editor.Selection.select('asset', uuid);
      return ok({ selected: uuid });
    },
  }),

  defineTool({
    name: 'panel_open',
    label: '打开面板',
    description: '打开指定编辑器面板（名称如 inspector、hierarchy、assets、console）。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '面板名称' } },
      required: ['name'],
      additionalProperties: false,
    },
    risk: 'read',
    skipGate: true,
    async handler(args) {
      const name = strArg(args, 'name');
      if (!name) return fail('INVALID_ARGS', '缺少面板名称。');
      const opened = await Editor.Panel.open(name);
      return ok({ opened });
    },
  }),

  defineTool({
    name: 'panel_close',
    label: '关闭面板',
    description: '关闭指定编辑器面板。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '面板名称' } },
      required: ['name'],
      additionalProperties: false,
    },
    risk: 'read',
    skipGate: true,
    async handler(args) {
      const name = strArg(args, 'name');
      if (!name) return fail('INVALID_ARGS', '缺少面板名称。');
      await Editor.Panel.close(name);
      return ok({ closed: name });
    },
  }),

  defineTool({
    name: 'panel_focus',
    label: '聚焦面板',
    description: '聚焦指定编辑器面板。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '面板名称' } },
      required: ['name'],
      additionalProperties: false,
    },
    risk: 'read',
    skipGate: true,
    async handler(args) {
      const name = strArg(args, 'name');
      if (!name) return fail('INVALID_ARGS', '缺少面板名称。');
      const focused = await Editor.Panel.focus(name);
      return ok({ focused });
    },
  }),

  defineTool({
    name: 'layout_apply',
    label: '应用布局',
    description: '应用布局 JSON，或按布局名称查询后应用。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '布局名称' },
        json: { type: 'object', description: '完整布局 JSON（优先）' },
      },
      additionalProperties: false,
    },
    risk: 'write',
    skipGate: true,
    async handler(args) {
      const json = objectArg(args, 'json');
      if (json) {
        await Editor.Layout.apply(json as any);
        return ok({ applied: 'json' });
      }
      const name = strArg(args, 'name');
      if (!name) return fail('INVALID_ARGS', '缺少布局名称或 JSON。');
      const layout = await Editor.Layout.query(name);
      await Editor.Layout.apply(layout);
      return ok({ applied: name });
    },
  }),

  defineTool({
    name: 'menu_trigger',
    label: '触发菜单',
    description:
      '触发编辑器菜单/消息。优先传 {target,name,params} 直接发消息；也可传 {path} 按菜单路径查找其 message。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '菜单路径，如 i18n:menu.develop/i18n:cocos-ai-agent.open_panel' },
        target: { type: 'string', description: '消息 target' },
        name: { type: 'string', description: '消息 name' },
        params: { type: 'array', items: {}, description: '消息参数' },
      },
      additionalProperties: false,
    },
    risk: 'read',
    skipGate: true,
    async handler(args) {
      const target = strArg(args, 'target');
      const messageName = strArg(args, 'name');
      const params = Array.isArray(args.params) ? args.params : [];
      if (target && messageName) {
        const result = await (Editor.Message.request as any)(target, messageName, ...params);
        return ok({ triggered: true, target, name: messageName, result });
      }
      const menuPath = strArg(args, 'path');
      if (!menuPath) return fail('INVALID_ARGS', '缺少 path 或 target/name。');
      const item = await findMenuItem(menuPath);
      if (!item) return fail('NOT_FOUND', `菜单不存在：${menuPath}`);
      if (item.message?.target && item.message?.name) {
        const result = await (Editor.Message.request as any)(
          item.message.target,
          item.message.name,
          ...(item.message.params ?? []),
        );
        return ok({ triggered: true, path: menuPath, result });
      }
      return fail('EDITOR_ERROR', `菜单项没有可执行消息：${menuPath}`);
    },
  }),

  defineTool({
    name: 'task_notify',
    label: '发送通知',
    description: '在编辑器任务通知区显示一条通知。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        message: { type: 'string' },
        type: { type: 'string', enum: ['error', 'warn', 'log', 'success'] },
        timeout: { type: 'number', description: '显示毫秒数' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    risk: 'read',
    skipGate: true,
    async handler(args) {
      const title = strArg(args, 'title');
      if (!title) return fail('INVALID_ARGS', '缺少 title。');
      const id = Editor.Task.addNotice({
        title,
        message: strArg(args, 'message'),
        type: (strArg(args, 'type') as 'error' | 'warn' | 'log' | 'success' | undefined) ?? 'log',
        source: PACKAGE_NAME,
        timeout: numArg(args, 'timeout'),
      });
      return ok({ noticeId: id });
    },
  }),

  defineTool({
    name: 'dialog_show',
    label: '显示对话框',
    description: '显示编辑器原生信息/警告/错误对话框。',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['info', 'warn', 'error'] },
        message: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['level', 'message'],
      additionalProperties: false,
    },
    risk: 'read',
    skipGate: true,
    async handler(args) {
      const level = strArg(args, 'level') ?? 'info';
      const message = strArg(args, 'message');
      if (!message) return fail('INVALID_ARGS', '缺少 message。');
      const fn = (Editor.Dialog as any)[level];
      if (typeof fn !== 'function') return fail('INVALID_ARGS', `不支持的对话框类型：${level}`);
      const result = await fn(message, { title: strArg(args, 'title') });
      return ok({ response: result?.response ?? null });
    },
  }),

  defineTool({
    name: 'editor_reload_package',
    label: '重载扩展',
    description: '禁用再启用指定扩展（让 JS 改动生效；可能导致扩展短暂不可用）。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '扩展包名' } },
      required: ['name'],
      additionalProperties: false,
    },
    risk: 'write',
    skipGate: true,
    async handler(args) {
      const name = strArg(args, 'name');
      if (!name) return fail('INVALID_ARGS', '缺少扩展包名。');
      await Editor.Package.disable(name);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await Editor.Package.enable(name);
      return ok({ reloaded: name });
    },
  }),
];

async function findMenuItem(path: string): Promise<any | null> {
  const tree = await (Editor.Menu as any).queryMain();
  const walk = (node: any): any | null => {
    if (!node || typeof node !== 'object') return null;
    for (const item of Object.values(node)) {
      const record = item as any;
      if (record?.path === path) return record;
      if (record?.submenu) {
        const found = walk(record.submenu);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(tree);
}
