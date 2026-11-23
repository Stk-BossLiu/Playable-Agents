import { MessageName, PACKAGE_NAME } from '../../shared/protocol';
import type { PanelEvent } from '../../shared/types';

/** main -> panel 的统一事件发送；面板未打开时静默失败。 */
export function sendPanelEvent<T = unknown>(event: PanelEvent<T>): void {
  const payload: PanelEvent<T> = { ...event, at: event.at ?? Date.now() };
  try {
    (Editor.Message.send as unknown as (target: string, message: string, payload: PanelEvent<T>) => void)(
      PACKAGE_NAME,
      MessageName.PanelEvent,
      payload,
    );
  } catch (error) {
    console.warn(`[${PACKAGE_NAME}] send panel event failed`, error);
  }
}

export function toast(level: 'info' | 'success' | 'warn' | 'error', message: string): void {
  sendPanelEvent({ type: 'toast', payload: { level, message } });
}

interface EditorContextPatch {
  scene?: { ready?: boolean; dirty?: boolean; uuid?: string | null; name?: string | null };
  selection?: { type?: string; id?: string };
  previewPort?: number;
  assetsChanged?: boolean;
  compileState?: 'start' | 'end';
  build?: { id?: string; state?: string; progress?: number; message?: string };
}

let contextTimer: NodeJS.Timeout | null = null;
let pendingContext: EditorContextPatch = {};
const listeners: Array<{ name: string; handler: (...args: any[]) => void }> = [];

function broadcast(name: string, handler: (...args: any[]) => void): void {
  try {
    (Editor.Message as unknown as {
      addBroadcastListener: (event: string, callback: (...args: any[]) => void) => void;
    }).addBroadcastListener(name, handler);
    listeners.push({ name, handler });
  } catch (error) {
    console.warn(`[${PACKAGE_NAME}] addBroadcastListener failed: ${name}`, error);
  }
}

function flushContext(): void {
  if (contextTimer) clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    const payload = pendingContext;
    pendingContext = {};
    if (Object.keys(payload).length === 0) return;
    sendPanelEvent({ type: 'editor-context', payload });
  }, 300);
}

function queueContext(patch: EditorContextPatch): void {
  pendingContext = {
    ...pendingContext,
    ...patch,
    ...(patch.scene ? { scene: { ...pendingContext.scene, ...patch.scene } } : {}),
  };
  flushContext();
}

/** 监听编辑器广播并转发到面板（selection/scene/compile/build/preview/asset）。 */
export function startEditorEventBridge(): void {
  broadcast('selection:select', (type: string, id: string) => {
    queueContext({ selection: { type, id } });
  });
  broadcast('selection:unselect', (type: string, id: string) => {
    queueContext({ selection: { type, id } });
  });
  broadcast('scene:ready', (uuid: string) => {
    queueContext({ scene: { ready: true, uuid } });
  });
  broadcast('scene:close', () => {
    queueContext({ scene: { ready: false, uuid: null } });
  });
  broadcast('scene:save', (uuid: string) => {
    queueContext({ scene: { dirty: false, uuid: uuid || undefined } });
  });
  broadcast('scene:change', () => {
    queueContext({ scene: { dirty: true } });
  });
  broadcast('asset-db:asset-change', () => {
    queueContext({ assetsChanged: true });
  });
  broadcast('programming:compile-start', (target: string) => {
    sendPanelEvent({ type: 'compile-state', payload: { state: 'start', target } });
  });
  broadcast('programming:compiled', (target: string) => {
    sendPanelEvent({ type: 'compile-state', payload: { state: 'end', target } });
  });
  broadcast('builder:task-changed', (id: string, task: unknown) => {
    const record = (task ?? {}) as { state?: string; progress?: number; message?: string };
    sendPanelEvent({
      type: 'build-progress',
      payload: {
        id,
        state: record.state,
        progress: record.progress,
        message: record.message,
      },
    });
  });
  broadcast('preview:port-change', (port: number) => {
    queueContext({ previewPort: port });
  });
}

export function stopEditorEventBridge(): void {
  if (contextTimer) {
    clearTimeout(contextTimer);
    contextTimer = null;
  }
  pendingContext = {};
  for (const listener of listeners) {
    try {
      (Editor.Message as unknown as {
        removeBroadcastListener: (event: string, callback: (...args: any[]) => void) => void;
      }).removeBroadcastListener(listener.name, listener.handler);
    } catch {
      // ignore
    }
  }
  listeners.length = 0;
}
