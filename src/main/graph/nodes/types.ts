import type { ArtifactRef, GraphDocument, GraphNode, GraphPortDefinition } from '../../../shared/graph';
import type { JsonSchema } from '../../bridge/schema';
import type { ToolResult } from '../../bridge/result';

export type NodeCategory =
  | 'source'
  | 'media'
  | 'analysis'
  | 'agent'
  | 'logic'
  | 'human'
  | 'output'
  | 'tool'
  | 'subgraph';

export interface WriteArtifactInput {
  /** 相对节点产物目录，例如 dev-plan.md 或 frames/001.png。 */
  path: string;
  content: string | Uint8Array;
  type: ArtifactRef['type'];
  name?: string;
  summary?: string;
  meta?: Record<string, unknown>;
}

export interface AgentRunRequest {
  prompt: string;
  systemPrompt?: string;
  /** 由图引擎注入：当前节点类型，用于解析每种 Agent 的独立模型配置。 */
  agentType?: string;
  /** 由图引擎注入：agent.role 节点的 role 参数（pm/designer/developer/validator）。 */
  agentRole?: string;
  images?: Array<{ type: 'image'; data: string; mimeType: string }>;
  modelProfileId?: string;
  visionProfileId?: string;
  provider?: string;
  model?: string;
  thinking?: string;
}

export interface AgentRunResult {
  text: string;
  model?: string;
  messages?: unknown[];
  meta?: Record<string, unknown>;
}

export interface HumanRunOption {
  id: string;
  label: string;
}

export interface HumanRunRequest {
  title: string;
  description?: string;
  kind?: 'approval' | 'question';
  options?: HumanRunOption[];
  timeoutMs?: number;
  payload?: unknown;
}

export interface HumanRunResult {
  decision: 'approve' | 'reject';
  feedback?: string;
  optionId?: string;
}

export type AgentNodeRunner = (
  request: AgentRunRequest,
  signal: AbortSignal,
  onStream: (kind: 'text' | 'thinking' | 'tool' | 'status', payload: Record<string, unknown>) => void,
) => Promise<AgentRunResult>;

export interface NodeRunContext {
  runId: string;
  graph: GraphDocument;
  node: GraphNode;
  params: Record<string, unknown>;
  inputs: Record<string, unknown>;
  signal: AbortSignal;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
  stream(kind: 'text' | 'thinking' | 'tool' | 'status', payload: Record<string, unknown>): void;
  /** 写入当前节点的产物目录，并返回可放入输出的 ArtifactRef。 */
  writeArtifact(input: WriteArtifactInput): Promise<ArtifactRef>;
  /** 主进程直接调用 ToolExecutor（不经过 MCP）。 */
  tool(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** 调用 Pi Agent；由 GraphEngine 注入，避免节点直接依赖进程管理。 */
  agent(request: AgentRunRequest): Promise<AgentRunResult>;
  /** 等待用户审批/回答；由 GraphEngine 注入。 */
  human(request: HumanRunRequest): Promise<HumanRunResult>;
}

export interface NodeResult {
  outputs?: Record<string, unknown>;
  artifacts?: ArtifactRef[];
  summary?: string;
  meta?: Record<string, unknown>;
}

export interface NodeDefinition {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  inputs: GraphPortDefinition[];
  outputs: GraphPortDefinition[];
  paramsSchema: JsonSchema;
  uiSchema?: Record<string, unknown>;
  requires?: string[];
  run(ctx: NodeRunContext): Promise<NodeResult>;
}

export interface NodeTypeDescriptor {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  inputs: GraphPortDefinition[];
  outputs: GraphPortDefinition[];
  paramsSchema: JsonSchema;
  uiSchema?: Record<string, unknown>;
  requires?: string[];
}
