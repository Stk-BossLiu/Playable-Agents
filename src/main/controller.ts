import { PACKAGE_NAME } from '../shared/protocol';
import type { GraphDocument } from '../shared/graph';
import type { ModelApiType, ModelProfileInput } from '../shared/models';
import type { AppInfo, PanelReadyPayload, SettingsPatch, ThinkingLevel } from '../shared/types';
import { createToolRegistry } from './tools';
import { GraphEngine, type GraphRunOptions } from './graph/engine';
import { createNodeRegistry, type NodeRegistry } from './graph/nodes';
import { RunStore } from './graph/run-store';
import { GraphStore } from './graph/store';
import { GraphError } from './graph/errors';
import type { ToolRegistry } from './bridge/schema';
import { ApprovalManager } from './bridge/approval';
import { ToolExecutor } from './bridge/executor';
import { EditorStateGate } from './bridge/state-gate';
import { AgentRuntime } from './services/agent';
import { DependencyService } from './services/dependencies';
import { writeDiagnostic } from './services/diagnostics';
import { sendPanelEvent, startEditorEventBridge, stopEditorEventBridge } from './services/events';

export class MainController {
  private readonly registry: ToolRegistry;
  private readonly gate: EditorStateGate;
  private readonly approval: ApprovalManager;
  private readonly executor: ToolExecutor;
  private readonly runtime: AgentRuntime;
  private readonly graphs: GraphStore;
  private readonly graphNodes: NodeRegistry;
  private readonly graphEngine: GraphEngine;
  private readonly runs: RunStore;
  private readonly dependencies: DependencyService;
  private readonly openPanels = new Set<string>();

  readonly methods: Record<string, (...args: any[]) => unknown> = {
    openPanel: (payload?: { view?: string }) => this.openPanelView(payload?.view ?? 'board'),
    openBoard: () => this.openPanelView('board'),
    openChat: () => this.openPanelView('chat'),
    openStatus: () => this.openPanelView('status'),
    appInfo: () => this.appInfo(),
    panelReady: (payload: PanelReadyPayload) => this.panelReady(payload),
    panelClosed: (payload?: { view?: string }) => this.panelClosed(payload),
    approvalRespond: (payload: { id?: string; approved?: boolean; always?: boolean }) =>
      this.approval.respond(String(payload?.id ?? ''), Boolean(payload?.approved), Boolean(payload?.always)),

    settingsGet: () => this.runtime.settingsGet(),
    settingsSet: (patch: SettingsPatch) => this.runtime.settingsSet(patch ?? {}),
    modelProfilesGet: () => this.runtime.models.getDTO(),
    modelProfileSave: (input: ModelProfileInput) => this.runtime.models.upsert(input ?? {}),
    modelProfileDelete: (payload: { id?: string }) => this.runtime.models.remove(String(payload?.id ?? '')),
    modelProfileValidate: (payload: { id?: string }) => this.runtime.models.validate(String(payload?.id ?? '')),
    modelListModels: (payload: { baseUrl?: string; secret?: string; profileId?: string; apiType?: ModelApiType }) =>
      this.runtime.models.listModels(payload ?? {}),
    modelProfileAddModels: (payload: {
      baseUrl?: string;
      secret?: string;
      profileId?: string;
      namePrefix?: string;
      apiType?: ModelApiType;
      vision?: boolean;
      contextWindow?: number;
      maxTokens?: number;
      reasoning?: boolean;
      modelIds?: string[];
    }) => this.runtime.models.addModels(payload ?? {}),
    modelProviderSave: (payload: {
      profileIds?: string[];
      name?: string;
      baseUrl?: string;
      apiType?: ModelApiType;
      secret?: string;
      models?: Array<{
        id?: string;
        name?: string;
        modelId?: string;
        vision?: boolean;
        reasoning?: boolean;
        contextWindow?: number;
        maxTokens?: number;
      }>;
    }) => this.runtime.models.saveProviderModels(payload ?? {}),
    modelProviderDelete: (payload: { profileIds?: string[] }) =>
      this.runtime.models.removeProfiles(payload?.profileIds ?? []),
    modelProfileApply: async () => {
      const applied = await this.runtime.models.apply();
      let restarted = false;
      let restartError = '';
      if (this.runtime.agentProcess.running) {
        const result = await this.runtime.restart();
        restarted = result.ok;
        if (!result.ok) restartError = result.error.message;
      }
      return { ...applied, restarted, ...(restartError ? { restartError } : {}) };
    },
    modelDefaultsSet: (payload: {
      defaultProfileId?: string | null;
      visionProfileId?: string | null;
      agentProfiles?: Record<string, string | null>;
    }) => this.runtime.models.setDefaults(payload ?? {}),
    dependenciesGet: () => this.dependencies.check(),
    piDownload: () => this.runtime.downloadPi(),
    piSelectPath: () => this.runtime.selectPiPath(),

    agentStart: () => this.runtime.start(),
    agentStop: () => this.runtime.stop(),
    agentRestart: () => this.runtime.restart(),
    agentStatus: () => this.runtime.getStatusAsync(),

    agentPrompt: (payload: { message?: string; images?: Array<{ type: 'image'; data: string; mimeType: string }> }) =>
      this.runtime.prompt(String(payload?.message ?? ''), payload?.images),
    agentSteer: (payload: { message?: string }) => this.runtime.steer(String(payload?.message ?? '')),
    agentFollowUp: (payload: { message?: string }) => this.runtime.followUp(String(payload?.message ?? '')),
    agentAbort: () => this.runtime.abort(),
    agentClearQueue: () => this.runtime.clearQueue(),
    agentState: () => this.runtime.getState(),
    agentMessages: () => this.runtime.getMessages(),
    agentSetModel: (payload: { provider?: string; modelId?: string }) =>
      this.runtime.setModel(String(payload?.provider ?? ''), String(payload?.modelId ?? '')),
    agentModels: () => this.runtime.getAvailableModels(),
    agentSetThinking: (payload: { level?: ThinkingLevel }) =>
      this.runtime.setThinking((payload?.level ?? 'off') as ThinkingLevel),
    agentThinkingLevels: () => this.runtime.getThinkingLevels(),
    agentCommands: () => this.runtime.getCommands(),
    agentCompact: () => this.runtime.compact(),
    agentExport: () => this.runtime.exportHtml(),
    agentStats: () => this.runtime.getStats(),
    agentNewSession: () => this.runtime.newSession(),
    agentSessions: () => this.runtime.listSessions(),
    agentSwitchSession: (payload: { path?: string }) => this.runtime.switchSession(String(payload?.path ?? '')),
    agentSessionDelete: (payload: { path?: string }) => this.runtime.deleteSession(String(payload?.path ?? '')),

    graphList: () => this.graphs.list(),
    graphLoad: (payload: { id?: string }) => this.graphs.load(String(payload?.id ?? '')),
    graphSave: (payload: { graph?: GraphDocument; overwrite?: boolean }) =>
      this.graphs.save(payload?.graph as GraphDocument, { overwrite: payload?.overwrite }),
    graphCreate: (payload: { id?: string; name?: string; description?: string }) =>
      this.graphs.create({
        id: String(payload?.id ?? ''),
        name: String(payload?.name ?? ''),
        ...(payload?.description ? { description: payload.description } : {}),
      }),
    graphDelete: (payload: { id?: string }) => this.graphs.delete(String(payload?.id ?? '')),
    graphImport: (payload: { json?: unknown; id?: string; name?: string; save?: boolean }) =>
      this.graphs.importGraph(payload?.json, {
        ...(payload?.id ? { id: payload.id } : {}),
        ...(payload?.name ? { name: payload.name } : {}),
        save: payload?.save !== false,
      }),
    graphExport: (payload: { id?: string }) => this.graphs.exportGraph(String(payload?.id ?? '')),
    graphDuplicate: (payload: { id?: string; newId?: string; name?: string }) =>
      this.graphs.duplicate({
        id: String(payload?.id ?? ''),
        ...(payload?.newId ? { newId: payload.newId } : {}),
        ...(payload?.name ? { name: payload.name } : {}),
      }),
    graphValidate: (payload: { graph?: unknown }) => this.graphs.validate(payload?.graph),
    graphNodeTypes: () => this.graphNodes.list(),
    graphRun: (payload: { graph?: GraphDocument; id?: string; options?: GraphRunOptions }) =>
      this.runGraph(payload?.graph, payload?.id, payload?.options),
    graphRunPause: (payload: { runId?: string }) => this.graphEngine.pause(String(payload?.runId ?? '')),
    graphRunResume: (payload: { runId?: string }) => this.graphEngine.resume(String(payload?.runId ?? '')),
    graphRunCancel: (payload: { runId?: string }) => this.graphEngine.cancel(String(payload?.runId ?? '')),
    graphHumanRespond: (payload: { id?: string; decision?: 'approve' | 'reject'; feedback?: string; optionId?: string }) =>
      this.graphEngine.respondHuman(String(payload?.id ?? ''), {
        decision: payload?.decision === 'reject' ? 'reject' : 'approve',
        ...(payload?.feedback ? { feedback: payload.feedback } : {}),
        ...(payload?.optionId ? { optionId: payload.optionId } : {}),
      }),
    graphRunList: (payload: { graphId?: string }) => this.runs.listRuns(String(payload?.graphId ?? '')),
    graphRunLoad: (payload: { graphId?: string; runId?: string }) =>
      this.runs.loadRun(String(payload?.graphId ?? ''), String(payload?.runId ?? '')),
    graphArtifactRead: (payload: { path?: string; maxBytes?: number }) =>
      this.runs.readArtifact(String(payload?.path ?? ''), payload?.maxBytes),
    graphRunDelete: (payload: { graphId?: string; runId?: string }) =>
      this.runs.deleteRun(String(payload?.graphId ?? ''), String(payload?.runId ?? '')),
    graphRunOpenDir: (payload: { graphId?: string; runId?: string }) =>
      this.openRunDir(String(payload?.graphId ?? ''), String(payload?.runId ?? '')),
  };

  constructor() {
    this.registry = createToolRegistry();
    this.runtime = new AgentRuntime(this.registry);
    this.graphs = new GraphStore();
    this.graphNodes = createNodeRegistry();
    this.runs = new RunStore(Editor.Project.path);
    this.dependencies = new DependencyService(this.runtime);
    this.graphEngine = new GraphEngine({
      registry: this.graphNodes,
      projectRoot: Editor.Project.path,
      runStore: this.runs,
      tool: (name, args) =>
        this.executor.execute(name, args, {
          bridgeUrl: this.runtime.bridge.getUrl(),
          toolCount: this.registry.getSchemas().length,
        }),
      event: (event) => sendPanelEvent({ type: event.type, payload: event.payload }),
      agent: (request, signal, onStream) => this.runtime.runNodeAgent(request, signal, onStream),
    });
    this.gate = new EditorStateGate();
    this.approval = new ApprovalManager({
      send: (event) => sendPanelEvent(event),
      getConfirmMode: () => this.runtime.settings.get().confirmMode,
      getWhenPanelClosed: () => this.runtime.settings.get().approvalWhenPanelClosed,
      isPanelOpen: () => this.openPanels.size > 0,
    });
    this.executor = new ToolExecutor(this.registry, this.gate, this.approval);
    this.runtime.setToolExecutor(this.executor);
  }

  async load(): Promise<void> {
    writeDiagnostic({
      loadAt: new Date().toISOString(),
      editorVersion: Editor.App.version,
      projectPath: Editor.Project.path,
      pid: process.pid,
    });
    await this.runtime.init();
    startEditorEventBridge();
    console.log(`[${PACKAGE_NAME}] loaded`);

    // 开发期便利开关：COCOS_AI_AGENT_AUTO_OPEN=1 时自动打开面板，便于无 UI 自动化验证。
    if (process.env.COCOS_AI_AGENT_AUTO_OPEN === '1') {
      try {
        // 等消息注册完成，避免面板 ready 立即 request panel-ready 时命中 Message does not exist。
        await new Promise((resolve) => setTimeout(resolve, 400));
        await this.openPanelView('board');
        writeDiagnostic({ panelOpenRequestedAt: new Date().toISOString() });
      } catch (error) {
        console.warn(`[${PACKAGE_NAME}] panel auto-open failed`, error);
        writeDiagnostic({ panelOpenError: String(error) });
      }
    }
  }

  async unload(): Promise<void> {
    writeDiagnostic({ unloadAt: new Date().toISOString() });
    this.approval.cancelAll();
    stopEditorEventBridge();
    await this.runtime.dispose();
    console.log(`[${PACKAGE_NAME}] unloaded`);
  }

  beforeUnload(): boolean {
    return this.runtime.beforeUnload();
  }

  /** 单一面板内切换视图；优先停靠在属性检查器旁边。 */
  private async openPanelView(view: string): Promise<boolean> {
    let opened = false;
    try {
      opened = await Editor.Panel.openBeside('inspector', PACKAGE_NAME);
    } catch (error) {
      console.warn(`[${PACKAGE_NAME}] open beside inspector failed`, error);
    }
    if (!opened) {
      try {
        opened = await Editor.Panel.open(PACKAGE_NAME);
      } catch (error) {
        console.warn(`[${PACKAGE_NAME}] open panel failed`, error);
      }
    }
    return opened;
  }

  private appInfo(): AppInfo {
    return {
      name: PACKAGE_NAME,
      version: '0.1.0',
      editorVersion: Editor.App.version,
      projectPath: Editor.Project.path,
    };
  }

  private async runGraph(
    graph: GraphDocument | undefined,
    id: string | undefined,
    options: GraphRunOptions | undefined,
  ): Promise<unknown> {
    let document = graph;
    if (!document) {
      if (!id) throw new GraphError('GRAPH_INVALID', '运行图需要 graph 或 id。');
      document = (await this.graphs.load(id)).graph;
    }
    return this.graphEngine.run(document, options ?? {});
  }

  /** 在系统文件管理器中打开某次运行的产物目录。 */
  private async openRunDir(graphId: string, runId: string): Promise<boolean> {
    if (!graphId || !runId) throw new GraphError('GRAPH_INVALID', '缺少 graphId 或 runId。');
    const dir = this.runs.runDir(graphId, runId);
    const electron = require('electron') as { shell: { openPath(path: string): Promise<string> } };
    const error = await electron.shell.openPath(dir);
    if (error) throw new GraphError('GRAPH_IO_ERROR', error);
    return true;
  }

  private panelReady(payload: PanelReadyPayload): boolean {
    this.openPanels.add(payload?.view ?? 'chat');
    writeDiagnostic({ panelReadyAt: new Date().toISOString(), panelReadyPayload: payload });
    return true;
  }

  private panelClosed(payload?: { view?: string }): boolean {
    if (payload?.view) this.openPanels.delete(payload.view);
    else this.openPanels.clear();
    return true;
  }
}
