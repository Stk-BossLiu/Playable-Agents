export interface AppInfo {
  name: string;
  version: string;
  editorVersion: string;
  projectPath: string;
}

export interface PanelReadyPayload {
  at: number;
  view?: 'board' | 'chat' | 'status' | 'shell';
  locale: 'zh' | 'en';
  theme: 'dark' | 'light';
}

export interface PanelEvent<T = unknown> {
  type: string;
  payload?: T;
  at?: number;
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ThinkingSetting = ThinkingLevel | 'default';

export interface Settings {
  provider: string;
  model: string;
  thinking: ThinkingSetting;
  piVersion: string;
  piPath: string;
  piMirror: string;
  autoStartAgent: boolean;
  resumeLastSession: boolean;
  maxTreeNodes: number;
  language: 'zh' | 'en';
  theme: 'auto' | 'dark' | 'light';
  confirmMode: 'always' | 'destructive' | 'never';
  approvalWhenPanelClosed: 'deny' | 'allow';
}

export interface SettingsPatch {
  provider?: string;
  model?: string;
  thinking?: ThinkingSetting;
  piVersion?: string;
  piPath?: string;
  piMirror?: string;
  autoStartAgent?: boolean;
  resumeLastSession?: boolean;
  maxTreeNodes?: number;
  language?: 'zh' | 'en';
  theme?: 'auto' | 'dark' | 'light';
  confirmMode?: 'always' | 'destructive' | 'never';
  approvalWhenPanelClosed?: 'deny' | 'allow';
  apiKeys?: Record<string, string>;
}

export interface SettingsDTO {
  settings: Settings;
  maskedKeys: Record<string, string>;
  hasApiKey: Record<string, boolean>;
}

export interface PiBinaryInfo {
  path: string;
  source: 'custom' | 'downloaded' | 'path';
  version: string;
  platform: string;
  arch: string;
}

export interface PiDownloadProgress {
  phase: 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'error';
  percent: number;
  received: number;
  total: number;
  message?: string;
}

export interface AgentSessionSummary {
  id: string;
  name: string;
  path: string;
  updatedAt: string;
  messageCount: number;
  preview?: string;
  model?: string;
}

export interface AgentStatus {
  compacting?: boolean;
  running: boolean;
  pid?: number;
  startedAt?: number;
  uptimeMs?: number;
  bridgeUrl?: string;
  toolCount?: number;
  model?: string;
  sessionFile?: string;
  error?: string;
  stderrTail?: string[];
}

export interface PromptResponse {
  ok: boolean;
  disposition?: 'started' | 'queued' | 'handled';
  error?: { code: string; message: string; hint?: string };
}

export interface SettingsGetResponse {
  settings: Settings;
  maskedKeys: Record<string, string>;
  hasApiKey: Record<string, boolean>;
  binary: PiBinaryInfo | null;
}
