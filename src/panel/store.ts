import type { ArtifactRef } from '../shared/graph';
import { reactive } from 'vue';
import type {
  AgentStatus,
  AppInfo,
  PanelEvent,
  PiBinaryInfo,
  PiDownloadProgress,
  Settings,
} from '../shared/types';

export interface ToolCallView {
  id: string;
  name: string;
  args?: unknown;
  argsText?: string;
  status: 'running' | 'success' | 'error';
  resultText?: string;
  isError?: boolean;
  durationMs?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  thinking: string;
  streaming: boolean;
  timestamp: number;
  toolCalls: ToolCallView[];
  optimistic?: boolean;
  error?: string;
}

export type ToastLevel = 'info' | 'success' | 'warn' | 'error';

export interface ApprovalView {
  id: string;
  tool: string;
  summary: string;
  risk: 'read' | 'write' | 'destroy';
  argsPreview?: string;
  timeoutMs: number;
  requestedAt: number;
}

export interface EditorContextView {
  scene?: { ready?: boolean; dirty?: boolean; uuid?: string | null; name?: string | null };
  selection?: { type?: string; id?: string };
  previewPort?: number;
  assetsChanged?: boolean;
  compileState?: 'start' | 'end';
  build?: { id?: string; state?: string; progress?: number; message?: string };
}

export interface HumanRequestView {
  id: string;
  runId: string;
  nodeId: string;
  title: string;
  description?: string;
  kind?: 'approval' | 'question';
  options?: Array<{ id: string; label: string }>;
  timeoutMs?: number;
  /** human 节点传入的待审内容：通常为 { markdown, json, data }，提问节点为上下文。 */
  payload?: unknown;
}

export interface NodeResultView {
  state: string;
  error?: string;
  cached?: boolean;
  durationMs?: number;
  outputs?: Record<string, unknown>;
  artifacts?: ArtifactRef[];
}

export interface GraphRunView {
  graphId?: string;
  runId: string;
  status: 'idle' | 'running' | 'success' | 'error' | 'cancelled';
  nodes: Record<string, NodeResultView>;
  logs: Array<{ nodeId: string; level: string; message: string; at: number }>;
  artifacts: Record<string, unknown[]>;
}

export interface UiState {
  appInfo: AppInfo | null;
  settings: Settings | null;
  editorContext: EditorContextView;
  graphRun: GraphRunView;
  humanRequest: HumanRequestView | null;
  activeView: 'board' | 'chat' | 'status';
  maskedKeys: Record<string, string>;
  hasApiKey: Record<string, boolean>;
  binary: PiBinaryInfo | null;
  agent: AgentStatus;
  messages: ChatMessage[];
  currentAssistantId: string | null;
  running: boolean;
  streaming: boolean;
  compacting: boolean;
  contextRevision: number;
  queued: number;
  sending: boolean;
  error: string;
  drawer: 'settings' | null;
  download: PiDownloadProgress | null;
  approval: ApprovalView | null;
  toast: { level: ToastLevel; message: string } | null;
}

export const state = reactive<UiState>({
  appInfo: null,
  settings: null,
  editorContext: {},
  graphRun: { runId: '', status: 'idle', nodes: {}, logs: [], artifacts: {} },
  humanRequest: null,
  activeView: 'board',
  maskedKeys: {},
  hasApiKey: {},
  binary: null,
  agent: { running: false },
  messages: [],
  currentAssistantId: null,
  running: false,
  streaming: false,
  compacting: false,
  contextRevision: 0,
  queued: 0,
  sending: false,
  error: '',
  drawer: null,
  download: null,
  approval: null,
  toast: null,
});

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function handlePanelEvent(event: PanelEvent): void {
  switch (event.type) {
    case 'agent-event':
      handleAgentEvent(event.payload as Record<string, any>);
      break;
    case 'agent-status':
      applyAgentStatus(event.payload as AgentStatus);
      break;
    case 'agent-crashed': {
      const payload = event.payload as { code?: number; signal?: string; stderrTail?: string[] };
      state.running = false;
      state.streaming = false;
      state.error = `Agent 进程退出（code=${payload?.code ?? '?'}, signal=${payload?.signal ?? '-'}）`;
      if (payload?.stderrTail?.length) {
        state.error += `\n${payload.stderrTail.slice(-5).join('\n')}`;
      }
      break;
    }
    case 'pi-download-progress':
      state.download = event.payload as PiDownloadProgress;
      break;
    case 'approval-request':
      state.approval = event.payload as ApprovalView;
      break;
    case 'editor-context': {
      const payload = event.payload as EditorContextView;
      state.editorContext = {
        ...state.editorContext,
        ...payload,
        ...(payload.scene ? { scene: { ...state.editorContext.scene, ...payload.scene } } : {}),
      };
      break;
    }
    case 'compile-state': {
      const payload = event.payload as { state?: 'start' | 'end' };
      if (payload?.state) state.editorContext = { ...state.editorContext, compileState: payload.state };
      break;
    }
    case 'build-progress': {
      const payload = event.payload as EditorContextView['build'];
      state.editorContext = { ...state.editorContext, build: { ...state.editorContext.build, ...payload } };
      break;
    }
    case 'graph-run-start': {
      const payload = event.payload as { runId?: string; graphId?: string };
      state.graphRun = { graphId: payload?.graphId, runId: payload?.runId ?? '', status: 'running', nodes: {}, logs: [], artifacts: {} };
      break;
    }
    case 'node-state': {
      const payload = event.payload as Partial<NodeResultView> & { nodeId?: string };
      if (!payload?.nodeId || !payload.state) break;
      state.graphRun.nodes = {
        ...state.graphRun.nodes,
        [payload.nodeId]: { ...state.graphRun.nodes[payload.nodeId], state: payload.state, error: payload.error, cached: payload.cached, durationMs: payload.durationMs },
      };
      break;
    }
    case 'node-log': {
      const payload = event.payload as { nodeId?: string; level?: string; message?: string };
      if (!payload?.nodeId || !payload.message) break;
      state.graphRun.logs = [
        ...state.graphRun.logs,
        { nodeId: payload.nodeId, level: payload.level ?? 'info', message: payload.message, at: event.at ?? Date.now() },
      ].slice(-200);
      break;
    }
    case 'node-output': {
      const payload = event.payload as { runId?: string; nodeId?: string; artifacts?: ArtifactRef[]; outputs?: Record<string, unknown> };
      if (!payload?.nodeId || (payload.runId && payload.runId !== state.graphRun.runId)) break;
      const node = state.graphRun.nodes[payload.nodeId];
      if (node && payload.outputs) node.outputs = payload.outputs;
      state.graphRun.artifacts = {
        ...state.graphRun.artifacts,
        [payload.nodeId]: payload.artifacts ?? [],
      };
      break;
    }
    case 'graph-run-end': {
      const payload = event.payload as { status?: GraphRunView['status'] };
      state.graphRun.status = payload?.status ?? state.graphRun.status;
      break;
    }
    case 'switch-view': {
      const payload = event.payload as { view?: 'board' | 'chat' | 'status' };
      if (payload?.view === 'board' || payload?.view === 'chat' || payload?.view === 'status') {
        state.activeView = payload.view;
      }
      break;
    }
    case 'human-request':
      state.humanRequest = event.payload as HumanRequestView;
      break;
    case 'human-resolved': {
      const payload = event.payload as { id?: string };
      if (!payload?.id || state.humanRequest?.id === payload.id) state.humanRequest = null;
      break;
    }
    case 'approval-resolved': {
      const payload = event.payload as { id?: string };
      if (!payload?.id || state.approval?.id === payload.id) state.approval = null;
      break;
    }
    case 'toast': {
      const payload = event.payload as { level?: ToastLevel; message?: string };
      if (payload?.message) setToast(payload.level ?? 'info', payload.message);
      break;
    }
    default:
      break;
  }
}

export function applyAgentStatus(status: AgentStatus): void {
  Object.assign(state.agent, status);
  // state.running 表示“当前对话是否在跑”，不是 Pi 进程是否存活。
  // 进程已启动但空闲时不能显示停止按钮，也不能把下一次发送当成 steer。
  if (!status.running) {
    state.compacting = false;
    state.running = false;
    state.streaming = false;
  }
}

export function handleAgentEvent(event: Record<string, any>): void {
  if (!event || typeof event !== 'object') return;

  switch (event.type) {
    case 'agent_start':
      state.running = true;
      state.error = '';
      break;

    case 'turn_end':
      state.contextRevision++;
      break;

    case 'agent_settled':
      state.contextRevision++;
      state.running = false;
      state.streaming = false;
      state.currentAssistantId = null;
      state.queued = 0;
      break;

    case 'message_start': {
      const message = event.message;
      if (!message) break;
      if (message.role === 'user') {
        mergeUserMessage(message);
      } else if (message.role === 'assistant') {
        const created = addMessage({
          role: 'assistant',
          text: extractContent(message.content),
          thinking: extractThinking(message.content),
          streaming: true,
          timestamp: Date.now(),
        });
        state.currentAssistantId = created.id;
        state.streaming = true;
      }
      break;
    }

    case 'message_update': {
      const update = event.assistantMessageEvent;
      if (!update) break;
      const message = ensureAssistantMessage();
      switch (update.type) {
        case 'text_delta':
          if (typeof update.delta === 'string') message.text += update.delta;
          break;
        case 'thinking_delta':
          if (typeof update.delta === 'string') message.thinking += update.delta;
          break;
        case 'thinking_end':
          if (typeof update.content === 'string') message.thinking = update.content;
          break;
        case 'text_end':
          if (typeof update.content === 'string') message.text = update.content;
          break;
        case 'toolcall_start':
          ensureToolCall(String(update.id ?? ''), String(update.toolName ?? 'tool'), message);
          break;
        case 'toolcall_delta': {
          const id = String(update.id ?? '');
          const tool = findToolCall(id);
          if (tool && typeof update.delta === 'string') tool.argsText = `${tool.argsText ?? ''}${update.delta}`;
          break;
        }
        case 'toolcall_end': {
          const call = update.toolCall ?? {};
          const id = String(call.id ?? update.id ?? '');
          const tool = ensureToolCall(id, String(call.name ?? 'tool'), message);
          tool.args = call.arguments ?? call.args ?? tool.args;
          break;
        }
        case 'error':
          message.error = errorDetail(update.error) ?? errorDetail(event.message) ?? errorDetail(update.reason) ?? STREAM_ERROR;
          message.streaming = false;
          state.streaming = false;
          break;
        case 'done':
          message.streaming = false;
          state.streaming = false;
          break;
        default:
          break;
      }
      break;
    }

    case 'message_end': {
      const message = event.message;
      if (!message) break;
      if (message.role === 'assistant') {
        const target = findMessageById(String(message.id ?? '')) ?? ensureAssistantMessage();
        const text = extractContent(message.content);
        const thinking = extractThinking(message.content);
        if (text) target.text = text;
        if (thinking) target.thinking = thinking;
        target.error = errorDetail(message) ?? target.error ?? failureFallback(message.stopReason);
        target.streaming = false;
        if (target.id === state.currentAssistantId) state.currentAssistantId = null;
        state.streaming = false;
      } else if (message.role === 'user') {
        mergeUserMessage(message);
      }
      break;
    }

    case 'tool_execution_start': {
      const tool = ensureToolCall(String(event.toolCallId ?? ''), String(event.toolName ?? 'tool'));
      tool.args = event.args;
      tool.status = 'running';
      break;
    }

    case 'tool_execution_update': {
      const tool = findToolCall(String(event.toolCallId ?? ''));
      if (tool) tool.resultText = extractToolResult(event.partialResult);
      break;
    }

    case 'tool_execution_end': {
      const tool = ensureToolCall(String(event.toolCallId ?? ''), String(event.toolName ?? 'tool'));
      tool.status = event.isError ? 'error' : 'success';
      tool.isError = Boolean(event.isError);
      tool.durationMs = typeof event.durationMs === 'number' ? event.durationMs : undefined;
      tool.resultText = extractToolResult(event.result);
      break;
    }

    case 'queue_update':
      state.queued = (Array.isArray(event.steering) ? event.steering.length : 0) +
        (Array.isArray(event.followUp) ? event.followUp.length : 0);
      break;

    case 'compaction_start':
      state.compacting = true;
      break;
    case 'compaction_end':
      state.contextRevision++;
      if (event.errorMessage) setError(String(event.errorMessage));
      state.compacting = false;
      break;

    default:
      break;
  }
}

export function addUserMessage(text: string): ChatMessage {
  return addMessage({
    role: 'user',
    text,
    thinking: '',
    streaming: false,
    timestamp: Date.now(),
    optimistic: true,
  });
}

export function addMessage(
  partial: Omit<ChatMessage, 'id' | 'toolCalls'> & { id?: string; toolCalls?: ToolCallView[] },
): ChatMessage {
  const message: ChatMessage = {
    id: partial.id ?? newId('msg'),
    role: partial.role,
    text: partial.text ?? '',
    thinking: partial.thinking ?? '',
    streaming: Boolean(partial.streaming),
    timestamp: partial.timestamp ?? Date.now(),
    toolCalls: partial.toolCalls ?? [],
    optimistic: partial.optimistic,
    error: partial.error,
  };
  state.messages.push(message);
  return message;
}

export function resetMessages(): void {
  state.messages = [];
  state.currentAssistantId = null;
  state.streaming = false;
  state.queued = 0;
  state.error = '';
}

/** 从 pi get_messages 的历史恢复面板消息（Phase 1 先支持文本与工具调用块）。 */
export function hydrateMessages(rawMessages: unknown[]): void {
  resetMessages();
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== 'object') continue;
    const message = raw as Record<string, any>;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const toolCalls: ToolCallView[] = [];
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== 'object') continue;
        const record = block as Record<string, any>;
        if (record.type !== 'toolCall') continue;
        toolCalls.push({
          id: String(record.id ?? newId('tool')),
          name: String(record.name ?? 'tool'),
          args: record.arguments ?? record.args,
          status: 'success',
        });
      }
    }
    addMessage({
      role: message.role,
      error: message.role === 'assistant' ? errorDetail(message) ?? failureFallback(message.stopReason) : undefined,
      text: extractContent(message.content),
      thinking: extractThinking(message.content),
      streaming: false,
      timestamp: Number(message.timestamp ?? Date.now()),
      toolCalls,
    });
  }
}

export function setToast(level: ToastLevel, message: string): void {
  state.toast = { level, message };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (state.toast?.message === message) state.toast = null;
  }, 4000);
}

export function setError(message: string): void {
  state.error = message;
}

export function clearError(): void {
  state.error = '';
}

function mergeUserMessage(message: Record<string, any>): void {
  const text = extractContent(message.content);
  if (!text) return;
  const last = state.messages[state.messages.length - 1];
  if (last?.role === 'user' && last.optimistic && last.text === text) {
    last.optimistic = false;
    if (message.id) last.id = String(message.id);
    return;
  }
  if (last?.role === 'user' && last.text === text && !last.optimistic) return;
  addMessage({
    role: 'user',
    text,
    thinking: '',
    streaming: false,
    timestamp: Date.now(),
  });
}

function ensureAssistantMessage(): ChatMessage {
  const current = state.currentAssistantId ? findMessageById(state.currentAssistantId) : null;
  if (current && current.role === 'assistant') return current;
  const last = state.messages[state.messages.length - 1];
  if (last?.role === 'assistant') {
    state.currentAssistantId = last.id;
    return last;
  }
  const created = addMessage({
    role: 'assistant',
    text: '',
    thinking: '',
    streaming: true,
    timestamp: Date.now(),
  });
  state.currentAssistantId = created.id;
  state.streaming = true;
  return created;
}

const STREAM_ERROR = '模型流式输出失败';

function failureFallback(stopReason: unknown): string | undefined {
  return stopReason === 'error' ? STREAM_ERROR : undefined;
}

function errorDetail(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const detail of [record.errorMessage, record.message]) {
    if (typeof detail === 'string' && detail.trim()) return detail;
  }
  return undefined;
}

function findMessageById(id: string): ChatMessage | null {
  if (!id) return null;
  return state.messages.find((message) => message.id === id) ?? null;
}

function findToolCall(id: string): ToolCallView | null {
  if (!id) return null;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const tool = state.messages[index].toolCalls.find((call) => call.id === id);
    if (tool) return tool;
  }
  return null;
}

function ensureToolCall(id: string, name: string, message?: ChatMessage): ToolCallView {
  const existing = findToolCall(id);
  if (existing) return existing;
  const target = message ?? ensureAssistantMessage();
  const tool: ToolCallView = {
    id: id || newId('tool'),
    name,
    status: 'running',
  };
  target.toolCalls.push(tool);
  return tool;
}

export function extractContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          const record = block as Record<string, unknown>;
          if (record.type === 'text') return String(record.text ?? '');
          if (record.type === 'toolCall') return '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

export function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const record = block as Record<string, unknown>;
      if (record.type === 'thinking' || record.type === 'reasoning') {
        return String(record.thinking ?? record.text ?? record.content ?? '');
      }
      return '';
    })
    .join('');
}

function extractToolResult(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const record = result as Record<string, unknown>;
    const content = record.content;
    if (Array.isArray(content)) {
      const text = content
        .map((block) => {
          if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
            return String((block as Record<string, unknown>).text ?? '');
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
      if (text) return text;
    }
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
