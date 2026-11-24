/**
 * 面板 <-> 主进程 / agent 共享的消息名与事件类型。
 * 所有在 package.json contributions.messages 中注册的消息都应从这里引用。
 */
export const PACKAGE_NAME = 'cocos-ai-agent';
export const PANEL_NAME = 'default';

export const MessageName = {
  OpenPanel: 'open-panel',
  PanelEvent: 'panel-event',
  PanelReady: 'panel-ready',
  PanelClosed: 'panel-closed',
  AppInfo: 'app-info',
  ApprovalRespond: 'approval-respond',

  // Phase 1: settings + Pi binary
  SettingsGet: 'settings-get',
  SettingsSet: 'settings-set',
  PiDownload: 'pi-download',
  ReaInstall: 'rea-install',
  PiSelectPath: 'pi-select-path',

  // Phase 1: agent lifecycle
  AgentStart: 'agent-start',
  AgentStop: 'agent-stop',
  AgentRestart: 'agent-restart',
  AgentStatus: 'agent-status',

  // Phase 1: chat / RPC
  AgentPrompt: 'agent-prompt',
  AgentSteer: 'agent-steer',
  AgentFollowUp: 'agent-follow-up',
  AgentAbort: 'agent-abort',
  AgentClearQueue: 'agent-clear-queue',
  AgentState: 'agent-state',
  AgentMessages: 'agent-messages',
  AgentSetModel: 'agent-set-model',
  AgentModels: 'agent-models',
  AgentSetThinking: 'agent-set-thinking',
  AgentThinkingLevels: 'agent-thinking-levels',
  AgentCommands: 'agent-commands',
  AgentCompact: 'agent-compact',
  AgentExport: 'agent-export',
  AgentStats: 'agent-stats',
  AgentNewSession: 'agent-new-session',
  AgentSessions: 'agent-sessions',
  AgentSwitchSession: 'agent-switch-session',
  AgentSessionDelete: 'agent-session-delete',
} as const;

export type MessageNameValue = (typeof MessageName)[keyof typeof MessageName];

/** main -> panel 的统一事件信封；后续所有事件走 panel-event。 */
export const PanelEventType = {
  Toast: 'toast',
  AgentEvent: 'agent-event',
  AgentStatus: 'agent-status',
  AgentCrashed: 'agent-crashed',
  PiDownloadProgress: 'pi-download-progress',
  ApprovalRequest: 'approval-request',
  ApprovalResolved: 'approval-resolved',
  EditorContext: 'editor-context',
  BuildProgress: 'build-progress',
  CompileState: 'compile-state',
} as const;

export type PanelEventTypeValue = (typeof PanelEventType)[keyof typeof PanelEventType];

/** 设置变更后需要通知编辑器重新读取 package.json 的消息注册；Phase 1 先由 postbuild 校验。 */
export const PHASE1_MESSAGES = [
  MessageName.SettingsGet,
  MessageName.SettingsSet,
  MessageName.PiDownload,
  MessageName.PiSelectPath,
  MessageName.ApprovalRespond,
  MessageName.AgentStart,
  MessageName.AgentStop,
  MessageName.AgentRestart,
  MessageName.AgentStatus,
  MessageName.AgentPrompt,
  MessageName.AgentSteer,
  MessageName.AgentFollowUp,
  MessageName.AgentAbort,
  MessageName.AgentClearQueue,
  MessageName.AgentState,
  MessageName.AgentMessages,
  MessageName.AgentSetModel,
  MessageName.AgentModels,
  MessageName.AgentSetThinking,
  MessageName.AgentThinkingLevels,
  MessageName.AgentCommands,
  MessageName.AgentCompact,
  MessageName.AgentExport,
  MessageName.AgentStats,
  MessageName.AgentNewSession,
  MessageName.AgentSessions,
  MessageName.AgentSwitchSession,
  MessageName.AgentSessionDelete,
] as const;
