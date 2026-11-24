import { PLAYABLE_AGENT_TYPE } from './playable';

export type ModelApiType =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

export interface ModelValidationResult {
  ok: boolean;
  latencyMs?: number;
  models?: string[];
  error?: string;
  warning?: string;
  checkedAt?: string;
}

export interface ModelProfile {
  id: string;
  name: string;
  /** 所属提供商显示名（同一 baseURL 的模型共享）。 */
  providerName?: string;
  baseUrl: string;
  modelId: string;
  apiType: ModelApiType;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  validatedAt?: string;
  lastValidation?: ModelValidationResult;
}

export interface ModelProfileInput {
  id?: string;
  name?: string;
  baseUrl?: string;
  modelId?: string;
  apiType?: ModelApiType;
  vision?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  /** 留空表示不修改已保存的 secret。 */
  secret?: string;
}

export interface ModelProfileView extends ModelProfile {
  secretConfigured: boolean;
  maskedSecret: string;
  /** 写入 models.json 的 Pi provider 名，节点 provider 参数使用这个值。 */
  providerId: string;
}

/**
 * 可单独指定模型的 Agent 节点类型；media.image-caption 也使用 agent.vision 的配置。
 * agent.role.* 对应角色 Agent 里的 pm/designer/developer/validator 预设。
 */
export type AgentModelKind =
  | 'agent.llm'
  | 'agent.structured'
  | 'agent.role'
  | 'agent.role.pm'
  | 'agent.role.designer'
  | 'agent.role.developer'
  | 'agent.role.validator'
  | typeof PLAYABLE_AGENT_TYPE
  | 'agent.vision';

export const AGENT_MODEL_KINDS: AgentModelKind[] = [
  'agent.llm',
  'agent.structured',
  'agent.role',
  'agent.role.pm',
  'agent.role.designer',
  'agent.role.developer',
  'agent.role.validator',
  PLAYABLE_AGENT_TYPE,
  'agent.vision',
];

export type AgentModelProfiles = Partial<Record<AgentModelKind, string | null>>;

export interface ModelProfilesDTO {
  profiles: ModelProfileView[];
  defaultProfileId: string | null;
  visionProfileId: string | null;
  /** 每种 Agent 节点使用的模型 profile；null/缺省表示跟随默认（视觉类跟随视觉默认）。 */
  agentProfiles: AgentModelProfiles;
  piModelsPath: string;
  modelsConfigError?: string;
}
