import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  AgentSessionSummary,
  AgentStatus,
  PiBinaryInfo,
  PromptResponse,
  SettingsDTO,
  SettingsPatch,
  ThinkingLevel,
} from '../../shared/types';
import type { AgentModelKind } from '../../shared/models';
import { BridgeServer } from '../bridge/server';
import type { ToolContext, ToolRegistry } from '../bridge/schema';
import type { ToolResult } from '../bridge/result';
import { ModelProfileStore } from './model-profiles';
import type { AgentRunRequest, AgentRunResult } from '../graph/nodes/types';
import { AgentProcessManager } from '../pi/process';
import { PiBinaryManager } from '../pi/binary';
import { McpConfigWriter } from '../pi/mcp-config';
import { getExtensionRoot, devDir } from '../utils/paths';
import { assertInside, ensureDir } from '../utils/fs';
import { sendPanelEvent, toast } from './events';
import { writeDiagnostic } from './diagnostics';
import { SettingsStore } from './settings';

type Failure = { ok: false; error: { code: string; message: string; hint?: string } };
type Success<T = unknown> = { ok: true } & T;

function failure(code: string, message: string, hint?: string): Failure {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } };
}

export class AgentRuntime {
  readonly settings = new SettingsStore();
  readonly models = new ModelProfileStore();
  readonly binary = new PiBinaryManager(Editor.Project.path);
  readonly agentProcess = new AgentProcessManager();
  readonly mcpConfig = new McpConfigWriter();
  readonly bridge: BridgeServer;

  private startedAt = 0;
  private downloading = false;
  private crashCount = 0;
  private toolExecutor: { execute: (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> } | null = null;
  /** 同一个 Pi 进程只有一个当前模型，Agent 节点需要串行执行。 */
  private nodeAgentChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly registry: ToolRegistry) {
    this.bridge = new BridgeServer({
      registry,
      projectPath: Editor.Project.path,
      name: 'cocos',
      version: '0.1.0',
      execute: (name, args, ctx) => this.executeTool(name, args, ctx),
    });
    this.bindProcessEvents();
  }

  /** 由 MainController 注入 ToolExecutor（门禁/审批）；图引擎也复用同一个执行器。 */
  setToolExecutor(executor: { execute: (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> }): void {
    this.toolExecutor = executor;
  }

  async init(): Promise<void> {
    await this.settings.init();
    await this.models.init();
    await this.ensureBridge();
    if (this.settings.get().autoStartAgent) {
      void this.start().catch((error) => {
        console.warn('[cocos-ai-agent] auto start failed', error);
      });
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
    await this.bridge.stop();
    await this.mcpConfig.remove();
  }

  async ensureBridge(): Promise<string> {
    const url = await this.bridge.start();
    await this.mcpConfig.write(url);
    return url;
  }

  async start(): Promise<Failure | Success<{ alreadyRunning?: boolean }>> {
    if (this.agentProcess.running) {
      return { ok: true, alreadyRunning: true };
    }

    const settings = this.settings.get();
    const binary = await this.resolveBinary();
    if (!binary) {
      return failure(
        'PI_NOT_FOUND',
        '未找到 Pi 二进制。',
        '在设置中点击“下载 Pi”或选择一个已有的 pi 可执行文件。',
      );
    }

    let bridgeUrl: string;
    try {
      bridgeUrl = await this.ensureBridge();
    } catch (error) {
      return failure('BRIDGE_START_FAILED', `MCP 桥启动失败：${messageOf(error)}`);
    }

    let profileConfig: { provider: string; modelId: string; env: Record<string, string> } = {
      provider: '',
      modelId: '',
      env: {},
    };
    if (this.models.getProfiles().length > 0) {
      try {
        const applied = await this.models.apply();
        const spawn = this.models.getSpawnConfig();
        profileConfig = { provider: applied.provider, modelId: applied.modelId, env: spawn.env };
      } catch (error) {
        console.warn('[cocos-ai-agent] write models.json failed', error);
      }
    }

    const extensionPath = join(getExtensionRoot(), 'dist', 'cocos-tools.js');
    const sessionDir = ensureDir(devDir('sessions'));
    const projectName = basename(Editor.Project.path) || 'project';
    const env = {
      ...this.settings.getProviderEnv(),
      ...profileConfig.env,
      COCOS_AGENT_BRIDGE_URL: bridgeUrl,
      COCOS_AGENT_ROLE: 'chat',
    };

    try {
      this.agentProcess.start({
        piPath: binary.path,
        cwd: Editor.Project.path,
        sessionDir,
        name: `cocos-${projectName}`,
        provider: profileConfig.provider || settings.provider || undefined,
        model: profileConfig.modelId || settings.model || undefined,
        thinking: settings.thinking,
        extensionPath: existsSync(extensionPath) ? extensionPath : undefined,
        tools: 'read,bash,edit,write,codemode',
        env,
        resume: settings.resumeLastSession,
      });
    } catch (error) {
      return failure('PI_SPAWN_FAILED', `Pi 启动失败：${messageOf(error)}`, this.stderrHint());
    }

    const rpc = this.agentProcess.client;
    if (!rpc) {
      await this.agentProcess.stop();
      return failure('PI_SPAWN_FAILED', 'Pi 进程未返回 RPC 客户端。', this.stderrHint());
    }

    try {
      await Promise.race([
        rpc.getState(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Pi RPC 握手超时（20s）')), 20_000);
        }),
      ]);
    } catch (error) {
      const stderrTail = this.agentProcess.stderrTail;
      await this.agentProcess.stop();
      return failure('PI_RPC_NOT_READY', `Pi RPC 未就绪：${messageOf(error)}`, stderrTail.slice(-8).join('\n'));
    }

    this.startedAt = Date.now();
    this.crashCount = 0;
    this.sendStatus();
    return { ok: true };
  }

  async stop(): Promise<boolean> {
    await this.agentProcess.stop();
    this.startedAt = 0;
    this.sendStatus();
    return true;
  }

  async restart(): Promise<Failure | Success> {
    await this.stop();
    return this.start();
  }

  getStatus(): AgentStatus {
    const snapshot = this.agentProcess.status();
    return {
      running: snapshot.running,
      pid: snapshot.pid,
      startedAt: snapshot.startedAt,
      uptimeMs: snapshot.uptimeMs,
      bridgeUrl: this.bridge.getUrl(),
      toolCount: this.bridge.getToolCount(),
      stderrTail: snapshot.stderrTail.slice(-40),
    };
  }

  async getStatusAsync(): Promise<AgentStatus> {
    const status = this.getStatus();
    if (!status.running) return status;
    const rpc = this.agentProcess.client;
    if (!rpc) return status;
    try {
      const state = await rpc.getState();
      status.model = state.model?.id || state.model?.name;
      status.sessionFile = state.sessionFile;
    } catch {
      // 状态查询失败不影响进程状态
    }
    return status;
  }

  async prompt(message: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>): Promise<PromptResponse> {
    if (!message.trim()) return failure('INVALID_ARGS', '消息不能为空。');
    if (!this.agentProcess.running) {
      const started = await this.start();
      if (!started.ok) return started;
    }
    const rpc = this.agentProcess.client;
    if (!rpc) return failure('PI_NOT_READY', 'Pi 客户端不可用。', this.stderrHint());
    try {
      const result = await rpc.prompt(message, { images });
      return { ok: true, disposition: result.disposition };
    } catch (error) {
      return failure('PI_PROMPT_FAILED', messageOf(error), this.stderrHint());
    }
  }

  /**
   * Agent 节点运行时：发送 prompt，等待 agent_settled，再从消息历史提取最终 assistant 文本。
   * 取消时向 Pi 发 abort；不把 secret 写入日志。
   */
  async runNodeAgent(
    request: AgentRunRequest,
    signal: AbortSignal,
    onStream: (kind: 'text' | 'thinking' | 'tool' | 'status', payload: Record<string, unknown>) => void,
  ): Promise<AgentRunResult> {
    if (!request.prompt.trim()) throw new Error('Agent prompt 不能为空。');
    if (!this.agentProcess.running) {
      const started = await this.start();
      if (!started.ok) throw new Error(started.error.message);
    }
    // 串行化：不同 Agent 节点可能配置不同模型，而 Pi 进程只有一个“当前模型”。
    return this.withNodeAgentLock(() => this.runNodeAgentOnce(request, signal, onStream));
  }

  private withNodeAgentLock<T>(task: () => Promise<T>): Promise<T> {
    const next = this.nodeAgentChain.then(task, task);
    this.nodeAgentChain = next.catch(() => undefined);
    return next;
  }

  /** 节点类型 → 独立模型配置类别；图片描述节点沿用视觉 Agent 的配置。 */
  private nodeModelKind(agentType: string | undefined): AgentModelKind | null {
    switch (agentType) {
      case 'agent.llm':
      case 'agent.structured':
      case 'agent.role':
      case 'agent.vision':
        return agentType;
      case 'media.image-caption':
        return 'agent.vision';
      default:
        return null;
    }
  }

  private roleModelKind(role: string | undefined): AgentModelKind | null {
    switch (role) {
      case 'pm':
        return 'agent.role.pm';
      case 'designer':
        return 'agent.role.designer';
      case 'developer':
        return 'agent.role.developer';
      case 'validator':
        return 'agent.role.validator';
      default:
        return null;
    }
  }

  /** 角色 Agent 先查具体角色配置，再回退到通用 agent.role。 */
  private nodeModelKinds(agentType: string | undefined, agentRole: string | undefined): AgentModelKind[] {
    const kind = this.nodeModelKind(agentType);
    if (!kind) return [];
    if (kind === 'agent.role') {
      const roleKind = this.roleModelKind(agentRole);
      return roleKind ? [roleKind, 'agent.role'] : ['agent.role'];
    }
    return [kind];
  }

  /** 解析当前节点应使用的模型：节点参数 > 按类型/角色配置 > 视觉默认。 */
  private resolveNodeModel(request: AgentRunRequest): { provider: string; modelId: string } | null {
    if (request.provider && request.model) return { provider: request.provider, modelId: request.model };
    const kinds = this.nodeModelKinds(request.agentType, request.agentRole);
    const needsVision = kinds.includes('agent.vision') || Boolean(request.images?.length);
    const explicit = needsVision
      ? request.visionProfileId ?? request.modelProfileId
      : request.modelProfileId;
    const candidates = [
      explicit,
      ...kinds.map((kind) => this.models.getAgentProfileId(kind)),
      needsVision ? this.models.getDTO().visionProfileId : null,
    ];
    for (const id of candidates) {
      if (!id) continue;
      const resolved = this.models.resolveProfile(id);
      if (resolved) return resolved;
    }
    return null;
  }

  private async runNodeAgentOnce(
    request: AgentRunRequest,
    signal: AbortSignal,
    onStream: (kind: 'text' | 'thinking' | 'tool' | 'status', payload: Record<string, unknown>) => void,
  ): Promise<AgentRunResult> {
    // 等待锁期间可能已被取消。
    if (signal.aborted) throw new Error('Agent 运行已取消');
    const rpc = this.agentProcess.client;
    if (!rpc) throw new Error('Pi 客户端不可用。');
    const previous = await rpc.getState().catch(() => null);

    const target = this.resolveNodeModel(request);
    const switched = target
      ? previous?.model?.provider !== target.provider || previous?.model?.id !== target.modelId
      : false;
    if (target && switched) {
      try {
        await rpc.setModel(target.provider, target.modelId);
      } catch (error) {
        throw new Error(`切换模型失败（${target.provider}/${target.modelId}）：${messageOf(error)}`);
      }
    }
    if (request.thinking) {
      try {
        await rpc.setThinkingLevel(request.thinking as ThinkingLevel);
      } catch {
        // 模型/提供方不支持该思考级别时继续运行
      }
    }

    let streamedText = '';
    let settled = false;
    let settledResolve: (() => void) | null = null;
    let settledReject: ((error: Error) => void) | null = null;
    const settledPromise = new Promise<void>((resolve, reject) => {
      settledResolve = resolve;
      settledReject = reject;
    });
    const onEvent = (event: Record<string, unknown>): void => {
      const type = String(event.type ?? '');
      const assistant = (event.assistantMessageEvent ?? event) as Record<string, unknown>;
      const delta = assistant.delta ?? assistant.textDelta ?? assistant.text;
      if (assistant.type === 'text_delta' && typeof delta === 'string') {
        streamedText += delta;
        onStream('text', { text: delta });
      } else if (assistant.type === 'thinking_delta' && typeof delta === 'string') {
        onStream('thinking', { text: delta });
      } else if (type.includes('tool') && type.includes('start')) {
        onStream('tool', { name: event.name ?? event.toolName ?? '', args: event.args ?? event.arguments });
      } else if (type === 'error') {
        settledReject?.(new Error(String(event.message ?? event.error ?? 'Pi 运行失败')));
      } else if (type === 'agent_settled' || type === 'agent_end' || type === 'turn_end') {
        if (!settled) {
          settled = true;
          onStream('status', { state: 'settled' });
          settledResolve?.();
        }
      }
    };
    this.agentProcess.on('rpc-event', onEvent);
    const onAbort = (): void => {
      void rpc.abort().catch(() => undefined);
      settledReject?.(new Error('Agent 运行已取消'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      void rpc.abort().catch(() => undefined);
      settledReject?.(new Error('Agent 运行超时（10 分钟）'));
    }, 10 * 60 * 1000);

    try {
      onStream('status', { state: 'started' });
      const result = await rpc.prompt(request.prompt, {
        ...(request.images?.length ? { images: request.images } : {}),
      });
      if (result.disposition !== 'handled') {
        await settledPromise;
      }
      const messages = await rpc.getMessages().catch(() => ({ messages: [] }));
      const finalText = extractAssistantText(messages.messages) || streamedText;
      const state = await rpc.getState().catch(() => null);
      return {
        text: finalText,
        ...(state?.model?.id || state?.model?.name ? { model: state.model.id ?? state.model.name } : {}),
        messages: messages.messages,
      };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      this.agentProcess.removeListener('rpc-event', onEvent);
      // 恢复节点运行前的模型/思考级别，避免影响后续对话或其他节点。
      if (switched && previous?.model?.provider && previous.model.id) {
        await rpc.setModel(previous.model.provider, previous.model.id).catch(() => undefined);
      }
      if (request.thinking && previous?.thinkingLevel) {
        await rpc.setThinkingLevel(previous.thinkingLevel as ThinkingLevel).catch(() => undefined);
      }
    }
  }

  async steer(message: string) {
    return this.withRpc('PI_STEER_FAILED', (rpc) => rpc.steer(message));
  }

  async followUp(message: string) {
    return this.withRpc('PI_FOLLOW_UP_FAILED', (rpc) => rpc.followUp(message));
  }

  async abort() {
    return this.withRpc('PI_ABORT_FAILED', (rpc) => rpc.abort());
  }

  async clearQueue() {
    return this.withRpc('PI_CLEAR_QUEUE_FAILED', (rpc) => rpc.clearQueue());
  }

  async getState() {
    return this.withRpc('PI_STATE_FAILED', (rpc) => rpc.getState());
  }

  async getMessages() {
    return this.withRpc('PI_MESSAGES_FAILED', (rpc) => rpc.getMessages());
  }

  async setModel(provider: string, modelId: string) {
    return this.withRpc('PI_SET_MODEL_FAILED', (rpc) => rpc.setModel(provider, modelId));
  }

  async getAvailableModels() {
    return this.withRpc('PI_MODELS_FAILED', (rpc) => rpc.getAvailableModels());
  }

  async setThinking(level: ThinkingLevel) {
    return this.withRpc('PI_SET_THINKING_FAILED', (rpc) => rpc.setThinkingLevel(level));
  }

  async getThinkingLevels() {
    return this.withRpc('PI_THINKING_LEVELS_FAILED', (rpc) => rpc.getAvailableThinkingLevels());
  }

  async getCommands() {
    return this.withRpc('PI_COMMANDS_FAILED', (rpc) => rpc.getCommands());
  }

  async compact() {
    return this.withRpc('PI_COMPACT_FAILED', (rpc) => rpc.compact());
  }

  async getStats() {
    return this.withRpc('PI_STATS_FAILED', (rpc) => rpc.getSessionStats());
  }

  async listSessions(): Promise<AgentSessionSummary[]> {
    const dir = devDir('sessions');
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const sessions: AgentSessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const path = join(dir, entry.name);
      try {
        const stat = await fsp.stat(path);
        const text = await fsp.readFile(path, 'utf8');
        const summary = summarizeSessionFile(path, text, stat.mtime.toISOString());
        sessions.push(summary);
      } catch {
        // 损坏/正在写入的会话文件跳过
      }
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async newSession() {
    return this.withRpc('PI_NEW_SESSION_FAILED', (rpc) => rpc.newSession());
  }

  async switchSession(path: string) {
    return this.withRpc('PI_SWITCH_SESSION_FAILED', (rpc) => rpc.switchSession(path));
  }

  /** 删除一个会话文件；若删除的是当前会话，先新开一个会话避免文件被占用。 */
  async deleteSession(path: string): Promise<{ ok: true; current: boolean; path: string }> {
    const sessionsRoot = devDir('sessions');
    const target = assertInside(sessionsRoot, resolve(path));
    if (!target.toLowerCase().endsWith('.jsonl')) {
      throw new Error('只能删除 .jsonl 会话文件。');
    }
    let current = false;
    if (this.agentProcess.running) {
      const state = await this.agentProcess.client?.getState().catch(() => null);
      if (state?.sessionFile && resolve(state.sessionFile) === target) {
        current = true;
        await this.newSession().catch(() => undefined);
      }
    }
    await fsp.unlink(target);
    return { ok: true, current, path: target };
  }

  async exportHtml(): Promise<Failure | Success<{ filePath: string }>> {
    const rpc = this.agentProcess.client;
    if (!rpc) return failure('PI_NOT_READY', 'Pi 未运行。', '先启动 agent。');
    try {
      const state = await rpc.getState();
      if (!state.sessionFile) return failure('PI_NO_SESSION', '当前会话没有可导出的 session 文件。');
      const output = join(devDir('exports'), `session-${Date.now()}.html`);
      ensureDir(dirname(output));
      const result = await rpc.exportHtml(state.sessionFile, output);
      return { ok: true, filePath: result.filePath ?? result.path ?? output };
    } catch (error) {
      return failure('PI_EXPORT_FAILED', messageOf(error), this.stderrHint());
    }
  }

  async settingsGet(): Promise<SettingsDTO & { binary: PiBinaryInfo | null }> {
    const dto = this.settings.getDTO();
    return { ...dto, binary: await this.resolveBinary() };
  }

  async settingsSet(patch: SettingsPatch): Promise<boolean> {
    const updated = await this.settings.update(patch);
    if (this.agentProcess.running && updated.provider && updated.model) {
      try {
        await this.agentProcess.client?.setModel(updated.provider, updated.model);
      } catch (error) {
        console.warn('[cocos-ai-agent] apply model after settings update failed', error);
      }
    }
    return true;
  }

  async downloadPi(): Promise<Failure | Success> {
    if (this.downloading) {
      return failure('PI_DOWNLOAD_IN_PROGRESS', 'Pi 正在下载中。');
    }
    this.downloading = true;
    const settings = this.settings.get();
    writeDiagnostic({
      lastPiDownload: {
        stage: 'start',
        at: new Date().toISOString(),
        version: settings.piVersion,
        mirror: settings.piMirror,
      },
    });
    void this.binary
      .download(
        { version: settings.piVersion, mirror: settings.piMirror, customPath: settings.piPath },
        (progress) => sendPanelEvent({ type: 'pi-download-progress', payload: progress }),
      )
      .then((info) => {
        toast('success', `Pi ${info.version} 已就绪：${info.path}`);
        writeDiagnostic({
          lastPiDownload: {
            stage: 'done',
            at: new Date().toISOString(),
            path: info.path,
            version: info.version,
          },
        });
        this.sendStatus();
      })
      .catch((error) => {
        const message = messageOf(error);
        console.error('[cocos-ai-agent] pi download failed', error);
        sendPanelEvent({
          type: 'pi-download-progress',
          payload: {
            phase: 'error',
            percent: 0,
            received: 0,
            total: 0,
            message,
          },
        });
        toast('error', `Pi 下载失败：${message}`);
        writeDiagnostic({
          lastPiDownload: {
            stage: 'error',
            at: new Date().toISOString(),
            error: message,
            stack: error instanceof Error ? error.stack : undefined,
          },
        });
      })
      .finally(() => {
        this.downloading = false;
      });
    return { ok: true };
  }

  async selectPiPath(): Promise<Failure | Success<{ path?: string; canceled?: boolean }>> {
    try {
      const result = await Editor.Dialog.select({
        title: '选择 pi 可执行文件',
        type: 'file',
        path: this.settings.get().piPath || undefined,
        filters: [
          {
            name: 'Pi executable',
            extensions: process.platform === 'win32' ? ['exe'] : ['*'],
          },
        ],
      });
      const file = result.filePaths?.[0];
      if (!file) return { ok: true, canceled: true };
      await this.settings.update({ piPath: file });
      return { ok: true, path: file };
    } catch (error) {
      return failure('PI_SELECT_PATH_FAILED', messageOf(error));
    }
  }

  async resolveBinary(): Promise<PiBinaryInfo | null> {
    const settings = this.settings.get();
    return this.binary.resolve({
      version: settings.piVersion,
      mirror: settings.piMirror,
      customPath: settings.piPath,
    });
  }

  beforeUnload(): boolean {
    // Phase 1: 直接允许关闭；Phase 2 接入运行中确认对话框。
    return true;
  }

  private async withRpc<T>(
    code: string,
    action: (rpc: NonNullable<AgentProcessManager['client']>) => Promise<T>,
  ): Promise<Failure | Success<{ data: T }>> {
    const rpc = this.agentProcess.client;
    if (!rpc) return failure('PI_NOT_READY', 'Pi 未运行。', '先启动 agent。');
    try {
      return { ok: true, data: await action(rpc) };
    } catch (error) {
      return failure(code, messageOf(error), this.stderrHint());
    }
  }

  private async executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (this.toolExecutor) return this.toolExecutor.execute(name, args, ctx);
    return this.registry.call(name, args, ctx);
  }

  private bindProcessEvents(): void {
    this.agentProcess.on('rpc-event', (event) => {
      sendPanelEvent({ type: 'agent-event', payload: event });
    });

    this.agentProcess.on('exit', (info: { code: number | null; signal: string | null; expected: boolean }) => {
      if (!info.expected) {
        this.crashCount += 1;
        sendPanelEvent({ type: 'agent-crashed', payload: info });
      }
      this.sendStatus();
    });

    this.agentProcess.on('spawn-error', (error: Error) => {
      toast('error', `Pi 进程启动失败：${error.message}`);
      this.sendStatus();
    });

    this.agentProcess.on('protocol-error', (error: unknown) => {
      console.warn('[cocos-ai-agent] pi protocol error', error);
    });
  }

  private sendStatus(): void {
    sendPanelEvent({ type: 'agent-status', payload: this.getStatus() });
  }

  private stderrHint(): string {
    const tail = this.agentProcess.stderrTail.slice(-8);
    return tail.length ? tail.join('\n') : '查看诊断页/编辑器控制台获取更多信息。';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeSessionFile(path: string, text: string, fallbackUpdatedAt: string): AgentSessionSummary {
  let id = basename(path, '.jsonl');
  let name = '';
  let model = '';
  let preview = '';
  let messageCount = 0;
  let updatedAt = fallbackUpdatedAt;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: Record<string, any>;
    try {
      entry = JSON.parse(line) as Record<string, any>;
    } catch {
      continue;
    }
    if (typeof entry.timestamp === 'string') updatedAt = entry.timestamp;
    if (entry.type === 'session' && typeof entry.id === 'string') id = entry.id;
    if (entry.type === 'session_info' && typeof entry.name === 'string') name = entry.name;
    if (entry.type === 'model_change' && typeof entry.modelId === 'string') model = entry.modelId;
    if (entry.type === 'message' && entry.message) {
      const role = entry.message.role;
      if (role === 'user' || role === 'assistant') messageCount += 1;
      if (role === 'user' && !preview) {
        preview = extractMessageText(entry.message.content).replace(/\s+/g, ' ').slice(0, 80);
      }
    }
  }
  return {
    id,
    name: name || `会话 ${id.slice(0, 8)}`,
    path,
    updatedAt,
    messageCount,
    ...(preview ? { preview } : {}),
    ...(model ? { model } : {}),
  };
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          const record = block as Record<string, unknown>;
          if (record.type === 'text') return String(record.text ?? '');
        }
        return '';
      })
      .join('');
  }
  return '';
}

function extractAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.role !== 'assistant') continue;
    if (typeof record.text === 'string' && record.text.trim()) return record.text;
    const content = record.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object') {
            const item = part as Record<string, unknown>;
            if (typeof item.text === 'string') return item.text;
            if (typeof item.content === 'string') return item.content;
          }
          return '';
        })
        .join('');
      if (text.trim()) return text;
    }
  }
  return '';
}
