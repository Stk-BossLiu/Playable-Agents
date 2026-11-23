/** 图工作流的共享类型；主进程、面板和后续图引擎共用。 */

export const GRAPH_SCHEMA_VERSION = 1;

export type GraphPortType =
  | 'text'
  | 'markdown'
  | 'image[]'
  | 'video'
  | 'json'
  | 'project'
  | 'plan'
  | 'artifact'
  | 'any'
  | (string & {});

export interface GraphPosition {
  x: number;
  y: number;
}

export interface GraphSize {
  width: number;
  height: number;
}

export interface GraphPortRef {
  node: string;
  port: string;
}

export interface GraphNode {
  id: string;
  type: string;
  title: string;
  position: GraphPosition;
  size?: GraphSize;
  params?: Record<string, unknown>;
  disabled?: boolean;
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: GraphPortRef;
  to: GraphPortRef;
  optional?: boolean;
  label?: string;
  meta?: Record<string, unknown>;
}

export interface GraphGroup {
  id: string;
  title: string;
  nodeIds: string[];
  color?: string;
  position?: GraphPosition;
  size?: GraphSize;
}

export interface GraphMeta {
  author?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface GraphDocument {
  schemaVersion: number;
  id: string;
  name: string;
  description?: string;
  builtin: boolean;
  version: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups?: GraphGroup[];
  meta?: GraphMeta;
}

export interface GraphSummary {
  id: string;
  name: string;
  description?: string;
  builtin: boolean;
  version: string;
  nodeCount: number;
  edgeCount: number;
  updatedAt?: string;
  /** 文件存在但无法解析/通过校验时的简短原因。 */
  invalid?: string;
}

export interface GraphPortDefinition {
  name: string;
  type: GraphPortType;
  required?: boolean;
  multiple?: boolean;
  description?: string;
}

export interface GraphNodeTypeInfo {
  type: string;
  category?: string;
  inputs?: GraphPortDefinition[];
  outputs?: GraphPortDefinition[];
}

export interface ArtifactRef {
  id: string;
  type: 'text' | 'markdown' | 'json' | 'image' | 'images' | 'video' | 'file';
  path?: string;
  url?: string;
  name: string;
  summary?: string;
  hash?: string;
  meta?: Record<string, unknown>;
}

export interface GraphIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
}

export interface GraphValidationResult {
  valid: boolean;
  errors: GraphIssue[];
  warnings: GraphIssue[];
}

export interface GraphLoadResult {
  graph: GraphDocument;
  builtin: boolean;
  path?: string;
}

export interface GraphSaveOptions {
  overwrite?: boolean;
}

export interface GraphImportOptions {
  id?: string;
  name?: string;
  save?: boolean;
}
