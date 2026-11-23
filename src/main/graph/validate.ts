import {
  GRAPH_SCHEMA_VERSION,
  type GraphDocument,
  type GraphEdge,
  type GraphIssue,
  type GraphNode,
  type GraphNodeTypeInfo,
  type GraphPortDefinition,
  type GraphValidationResult,
} from '../../shared/graph';
import { GraphError } from './errors';

export interface GraphValidationOptions {
  /** 节点类型目录；提供后会校验节点类型、端口、必填输入和类型兼容。 */
  catalog?: Record<string, GraphNodeTypeInfo> | Map<string, GraphNodeTypeInfo>;
  /** 有 catalog 时是否把未知节点类型当作错误，默认 true。 */
  strictTypes?: boolean;
  /** 是否检查必填输入已连线，默认 true（仅在 catalog 提供时生效）。 */
  requireConnectedInputs?: boolean;
}

const GRAPH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ELEMENT_ID_PATTERN = /^[^\s/\\]+$/;

export function validateGraph(value: unknown, options: GraphValidationOptions = {}): GraphValidationResult {
  const errors: GraphIssue[] = [];
  const warnings: GraphIssue[] = [];
  const error = (code: string, message: string, path?: string): void => {
    errors.push({ severity: 'error', code, message, ...(path ? { path } : {}) });
  };
  const warn = (code: string, message: string, path?: string): void => {
    warnings.push({ severity: 'warning', code, message, ...(path ? { path } : {}) });
  };

  if (!isRecord(value)) {
    error('GRAPH_NOT_OBJECT', '图文档必须是 JSON 对象。');
    return result(errors, warnings);
  }

  const doc = value as Record<string, unknown>;
  if (doc.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    error('GRAPH_SCHEMA_VERSION', `schemaVersion 必须是 ${GRAPH_SCHEMA_VERSION}。`, 'schemaVersion');
  }
  if (typeof doc.id !== 'string' || !GRAPH_ID_PATTERN.test(doc.id)) {
    error('GRAPH_ID_INVALID', '图 id 必须匹配 [A-Za-z0-9][A-Za-z0-9._-]{0,63}。', 'id');
  }
  if (typeof doc.name !== 'string' || !doc.name.trim()) {
    error('GRAPH_NAME_REQUIRED', '图 name 不能为空。', 'name');
  }
  if (typeof doc.builtin !== 'boolean') {
    error('GRAPH_BUILTIN_INVALID', 'builtin 必须是 boolean。', 'builtin');
  }
  if (typeof doc.version !== 'string' || !doc.version.trim()) {
    error('GRAPH_VERSION_REQUIRED', 'version 不能为空。', 'version');
  }
  if (doc.description !== undefined && typeof doc.description !== 'string') {
    error('GRAPH_DESCRIPTION_INVALID', 'description 必须是字符串。', 'description');
  }

  const nodesValue = doc.nodes;
  const edgesValue = doc.edges;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();

  if (!Array.isArray(nodesValue)) {
    error('GRAPH_NODES_INVALID', 'nodes 必须是数组。', 'nodes');
  } else {
    nodesValue.forEach((nodeValue, index) => {
      const node = validateNode(nodeValue, index, error);
      if (!node) return;
      if (nodeIds.has(node.id)) {
        error('GRAPH_DUPLICATE_NODE_ID', `节点 id 重复：${node.id}`, `nodes[${index}].id`);
      } else {
        nodeIds.add(node.id);
        nodes.push(node);
      }
    });
  }

  if (!Array.isArray(edgesValue)) {
    error('GRAPH_EDGES_INVALID', 'edges 必须是数组。', 'edges');
  } else {
    const edgeIds = new Set<string>();
    edgesValue.forEach((edgeValue, index) => {
      const edge = validateEdge(edgeValue, index, error);
      if (!edge) return;
      if (edgeIds.has(edge.id)) {
        error('GRAPH_DUPLICATE_EDGE_ID', `边 id 重复：${edge.id}`, `edges[${index}].id`);
        return;
      }
      edgeIds.add(edge.id);
      edges.push(edge);
    });
  }

  for (const [index, edge] of edges.entries()) {
    if (!nodeIds.has(edge.from.node)) {
      error('GRAPH_EDGE_FROM_MISSING', `边 ${edge.id} 的源节点不存在：${edge.from.node}`, `edges[${index}].from.node`);
    }
    if (!nodeIds.has(edge.to.node)) {
      error('GRAPH_EDGE_TO_MISSING', `边 ${edge.id} 的目标节点不存在：${edge.to.node}`, `edges[${index}].to.node`);
    }
  }

  validateGroups(doc.groups, nodeIds, error);
  validateCatalog(nodes, edges, options, error, warn);
  validateInputEdges(nodes, edges, options, error);
  validateCycles(nodes, edges, options, error);

  if (doc.meta !== undefined && !isRecord(doc.meta)) {
    error('GRAPH_META_INVALID', 'meta 必须是对象。', 'meta');
  }

  return result(errors, warnings);
}

export function assertValidGraph(value: unknown, options: GraphValidationOptions = {}): GraphDocument {
  const validation = validateGraph(value, options);
  if (!validation.valid) {
    throw new GraphError('GRAPH_INVALID', formatIssues(validation), validation);
  }
  return value as GraphDocument;
}

export function formatIssues(validation: GraphValidationResult): string {
  const parts = validation.errors.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message));
  return parts.slice(0, 8).join('；') || '图校验失败。';
}

export function catalogMap(
  catalog: GraphValidationOptions['catalog'],
): Map<string, GraphNodeTypeInfo> | undefined {
  if (!catalog) return undefined;
  return catalog instanceof Map ? catalog : new Map(Object.entries(catalog));
}

function validateNode(
  value: unknown,
  index: number,
  error: (code: string, message: string, path?: string) => void,
): GraphNode | null {
  if (!isRecord(value)) {
    error('GRAPH_NODE_INVALID', '节点必须是对象。', `nodes[${index}]`);
    return null;
  }
  if (typeof value.id !== 'string' || !ELEMENT_ID_PATTERN.test(value.id)) {
    error('GRAPH_NODE_ID_INVALID', '节点 id 不能为空且不能包含空白/斜杠。', `nodes[${index}].id`);
  }
  if (typeof value.type !== 'string' || !value.type.trim()) {
    error('GRAPH_NODE_TYPE_REQUIRED', '节点 type 不能为空。', `nodes[${index}].type`);
  }
  if (typeof value.title !== 'string') {
    error('GRAPH_NODE_TITLE_INVALID', '节点 title 必须是字符串。', `nodes[${index}].title`);
  }
  if (!isPosition(value.position)) {
    error('GRAPH_NODE_POSITION_INVALID', '节点 position 必须是 {x,y} 数字。', `nodes[${index}].position`);
  }
  if (value.size !== undefined && !isSize(value.size)) {
    error('GRAPH_NODE_SIZE_INVALID', '节点 size 必须是 {width,height} 正数。', `nodes[${index}].size`);
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    error('GRAPH_NODE_PARAMS_INVALID', '节点 params 必须是对象。', `nodes[${index}].params`);
  }
  if (value.disabled !== undefined && typeof value.disabled !== 'boolean') {
    error('GRAPH_NODE_DISABLED_INVALID', '节点 disabled 必须是 boolean。', `nodes[${index}].disabled`);
  }
  return {
    ...(value as unknown as GraphNode),
    id: String(value.id ?? ''),
    type: String(value.type ?? ''),
    title: String(value.title ?? ''),
  };
}

function validateEdge(
  value: unknown,
  index: number,
  error: (code: string, message: string, path?: string) => void,
): GraphEdge | null {
  if (!isRecord(value)) {
    error('GRAPH_EDGE_INVALID', '边必须是对象。', `edges[${index}]`);
    return null;
  }
  if (typeof value.id !== 'string' || !ELEMENT_ID_PATTERN.test(value.id)) {
    error('GRAPH_EDGE_ID_INVALID', '边 id 不能为空且不能包含空白/斜杠。', `edges[${index}].id`);
  }
  if (!isPortRef(value.from)) {
    error('GRAPH_EDGE_FROM_INVALID', '边 from 必须是 {node,port}。', `edges[${index}].from`);
    return null;
  }
  if (!isPortRef(value.to)) {
    error('GRAPH_EDGE_TO_INVALID', '边 to 必须是 {node,port}。', `edges[${index}].to`);
    return null;
  }
  if (value.optional !== undefined && typeof value.optional !== 'boolean') {
    error('GRAPH_EDGE_OPTIONAL_INVALID', '边 optional 必须是 boolean。', `edges[${index}].optional`);
  }
  return value as unknown as GraphEdge;
}

function validateGroups(
  value: unknown,
  nodeIds: Set<string>,
  error: (code: string, message: string, path?: string) => void,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    error('GRAPH_GROUPS_INVALID', 'groups 必须是数组。', 'groups');
    return;
  }
  const groupIds = new Set<string>();
  value.forEach((groupValue, index) => {
    if (!isRecord(groupValue)) {
      error('GRAPH_GROUP_INVALID', '分组必须是对象。', `groups[${index}]`);
      return;
    }
    if (typeof groupValue.id !== 'string' || !ELEMENT_ID_PATTERN.test(groupValue.id)) {
      error('GRAPH_GROUP_ID_INVALID', '分组 id 不能为空且不能包含空白/斜杠。', `groups[${index}].id`);
    } else if (groupIds.has(groupValue.id)) {
      error('GRAPH_DUPLICATE_GROUP_ID', `分组 id 重复：${groupValue.id}`, `groups[${index}].id`);
    } else {
      groupIds.add(groupValue.id);
    }
    if (typeof groupValue.title !== 'string') {
      error('GRAPH_GROUP_TITLE_INVALID', '分组 title 必须是字符串。', `groups[${index}].title`);
    }
    if (!Array.isArray(groupValue.nodeIds)) {
      error('GRAPH_GROUP_NODES_INVALID', '分组 nodeIds 必须是数组。', `groups[${index}].nodeIds`);
      return;
    }
    groupValue.nodeIds.forEach((nodeId, nodeIndex) => {
      if (typeof nodeId !== 'string' || !nodeIds.has(nodeId)) {
        error(
          'GRAPH_GROUP_NODE_MISSING',
          `分组引用了不存在的节点：${String(nodeId)}`,
          `groups[${index}].nodeIds[${nodeIndex}]`,
        );
      }
    });
  });
}

function validateCatalog(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: GraphValidationOptions,
  error: (code: string, message: string, path?: string) => void,
  warn: (code: string, message: string, path?: string) => void,
): void {
  const catalog = catalogMap(options.catalog);
  if (!catalog) return;
  const strictTypes = options.strictTypes !== false;
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  for (const [index, node] of nodes.entries()) {
    const info = catalog.get(node.type);
    if (!info) {
      if (strictTypes) {
        error('GRAPH_UNKNOWN_NODE_TYPE', `未知节点类型：${node.type}`, `nodes[${index}].type`);
      } else {
        warn('GRAPH_UNKNOWN_NODE_TYPE', `未注册节点类型：${node.type}`, `nodes[${index}].type`);
      }
      continue;
    }

    for (const [edgeIndex, edge] of edges.entries()) {
      if (edge.from.node !== node.id) continue;
      const port = findPort(info.outputs, edge.from.port);
      if (!port) {
        error(
          'GRAPH_OUTPUT_PORT_MISSING',
          `节点 ${node.id}（${node.type}）没有输出端口 ${edge.from.port}。`,
          `edges[${edgeIndex}].from.port`,
        );
        continue;
      }
      const targetNode = nodeMap.get(edge.to.node);
      const targetInfo = targetNode ? catalog.get(targetNode.type) : undefined;
      const targetPort = targetInfo ? findPort(targetInfo.inputs, edge.to.port) : undefined;
      if (targetInfo && !targetPort) {
        error(
          'GRAPH_INPUT_PORT_MISSING',
          `节点 ${edge.to.node}（${targetNode?.type}）没有输入端口 ${edge.to.port}。`,
          `edges[${edgeIndex}].to.port`,
        );
        continue;
      }
      if (targetPort && !portsCompatible(port.type, targetPort.type)) {
        error(
          'GRAPH_PORT_TYPE_MISMATCH',
          `端口类型不兼容：${node.id}.${edge.from.port}(${port.type}) → ${edge.to.node}.${edge.to.port}(${targetPort.type})`,
          `edges[${edgeIndex}]`,
        );
      }
    }
  }

  if (options.requireConnectedInputs !== false) {
    for (const [index, node] of nodes.entries()) {
      const info = catalog.get(node.type);
      if (!info?.inputs?.length) continue;
      for (const input of info.inputs) {
        if (!input.required) continue;
        const connected = edges.some((edge) => edge.to.node === node.id && edge.to.port === input.name);
        if (!connected) {
          error(
            'GRAPH_REQUIRED_INPUT_MISSING',
            `节点 ${node.id}（${node.type}）的必填输入 ${input.name} 未连线。`,
            `nodes[${index}]`,
          );
        }
      }
    }
  }
}

function validateInputEdges(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: GraphValidationOptions,
  error: (code: string, message: string, path?: string) => void,
): void {
  const catalog = catalogMap(options.catalog);
  const counts = new Map<string, number>();
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    const key = `${edge.to.node}:${edge.to.port}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    if (count <= 1) continue;
    const [nodeId, portName] = key.split(':');
    const node = nodeMap.get(nodeId);
    const info = node && catalog ? catalog.get(node.type) : undefined;
    const port = info ? findPort(info.inputs, portName) : undefined;
    // 没有节点目录时无法知道端口是否允许多连；只在目录明确声明非 multiple 时报错。
    if (port && !port.multiple) {
      error('GRAPH_INPUT_MULTIPLE', `输入端口 ${key} 只允许一条连线，实际 ${count} 条。`);
    }
  }
}

function validateCycles(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: GraphValidationOptions,
  error: (code: string, message: string, path?: string) => void,
): void {
  const catalog = catalogMap(options.catalog);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    if (adjacency.has(edge.from.node) && adjacency.has(edge.to.node)) {
      adjacency.get(edge.from.node)!.push(edge.to.node);
    }
  }

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const reported = new Set<string>();

  const isLoopNode = (nodeId: string): boolean => {
    const node = nodeMap.get(nodeId);
    if (!node) return false;
    const category = catalog?.get(node.type)?.category;
    return (
      category === 'subgraph' ||
      node.type === 'logic.loop' ||
      node.type.startsWith('logic.loop') ||
      node.type.startsWith('subgraph.')
    );
  };

  const visit = (nodeId: string): void => {
    state.set(nodeId, 1);
    stack.push(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      const nextState = state.get(next) ?? 0;
      if (nextState === 0) {
        visit(next);
      } else if (nextState === 1) {
        const start = stack.indexOf(next);
        const cycle = start >= 0 ? stack.slice(start) : [next];
        if (cycle.some((id) => isLoopNode(id))) continue;
        const key = [...cycle].sort().join('|');
        if (reported.has(key)) continue;
        reported.add(key);
        error('GRAPH_CYCLE', `检测到非法环：${[...cycle, cycle[0]].join(' → ')}`, 'edges');
      }
    }
    stack.pop();
    state.set(nodeId, 2);
  };

  for (const node of nodes) {
    if ((state.get(node.id) ?? 0) === 0) visit(node.id);
  }
}

function findPort(ports: GraphPortDefinition[] | undefined, name: string): GraphPortDefinition | undefined {
  return ports?.find((port) => port.name === name);
}

function portsCompatible(from: string, to: string): boolean {
  return from === 'any' || to === 'any' || from === to;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPosition(value: unknown): value is { x: number; y: number } {
  return (
    isRecord(value) &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  );
}

function isSize(value: unknown): value is { width: number; height: number } {
  return (
    isRecord(value) &&
    typeof value.width === 'number' &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    typeof value.height === 'number' &&
    Number.isFinite(value.height) &&
    value.height > 0
  );
}

function isPortRef(value: unknown): value is { node: string; port: string } {
  return (
    isRecord(value) &&
    typeof value.node === 'string' &&
    value.node.length > 0 &&
    typeof value.port === 'string' &&
    value.port.length > 0
  );
}

function result(errors: GraphIssue[], warnings: GraphIssue[]): GraphValidationResult {
  return { valid: errors.length === 0, errors, warnings };
}
