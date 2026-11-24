import { randomBytes } from 'node:crypto';
import type { ArtifactRef, GraphDocument, GraphNode } from '../../shared/graph';
import type { ToolResult } from '../bridge/result';
import { ArtifactStore } from './artifacts';
import { GraphError } from './errors';
import type {
  AgentNodeRunner,
  AgentRunRequest,
  HumanRunRequest,
  HumanRunResult,
  NodeDefinition,
  NodeResult,
  NodeRunContext,
} from './nodes/types';
import { NodeRegistry } from './nodes/registry';
import type { RunStore } from './run-store';
import { formatIssues, validateGraph } from './validate';

export type GraphRunMode = 'all' | 'node' | 'from';
export type GraphRunStatus = 'success' | 'error' | 'cancelled';
export type NodeRunState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'success'
  | 'error'
  | 'skipped'
  | 'waiting-user'
  | 'cancelled';

export interface GraphRunOptions {
  mode?: GraphRunMode;
  targetNodeId?: string;
  concurrency?: number;
  cache?: 'auto' | 'off' | 'force';
  retry?: number;
  onError?: 'stop' | 'continue' | 'skip';
  timeoutMs?: number;
}

export interface NodeRunInfo {
  nodeId: string;
  state: NodeRunState;
  attempt: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  error?: string;
  outputs?: Record<string, unknown>;
  artifacts?: ArtifactRef[];
  cached?: boolean;
}

export interface GraphRunResult {
  runId: string;
  graphId: string;
  status: GraphRunStatus;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  nodes: Record<string, NodeRunInfo>;
  error?: string;
}

export interface GraphEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface GraphEngineOptions {
  registry: NodeRegistry;
  projectRoot: string;
  tool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  event?: (event: GraphEvent) => void;
  concurrency?: number;
  /** 运行记录持久化；不传则只在内存中返回结果。 */
  runStore?: RunStore;
  /** Pi Agent 节点运行时；G3.4 由 controller 注入 AgentRuntime。 */
  agent?: AgentNodeRunner;
}

interface IncomingEdge {
  from: string;
  fromPort: string;
  toPort: string;
  optional: boolean;
}

interface ActiveRun {
  runId: string;
  graph: GraphDocument;
  control: RunControl;
  states: Map<string, NodeRunInfo>;
  artifacts: ArtifactStore;
  incoming: Map<string, IncomingEdge[]>;
  target: Set<string>;
  options: GraphRunOptions;
  failed: boolean;
  startedAt: number;
}

interface PendingHuman {
  id: string;
  runId: string;
  nodeId: string;
  active: ActiveRun;
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: () => void;
  resolve: (result: HumanRunResult) => void;
  reject: (error: Error) => void;
}

/**
 * 图执行引擎：校验 → 拓扑分层 → 同层并发 → 节点状态/日志/产物事件。
 * G3.2 支持 DAG；loop/subgraph 的迟到循环由 G5.7 扩展。
 */
export class GraphEngine {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly humans = new Map<string, PendingHuman>();
  private readonly cache = new Map<string, NodeResult>();

  constructor(private readonly options: GraphEngineOptions) {}

  async run(graph: GraphDocument, options: GraphRunOptions = {}): Promise<GraphRunResult> {
    const validation = validateGraph(graph, { catalog: this.options.registry.catalog() });
    if (!validation.valid) {
      throw new GraphError('GRAPH_INVALID', formatIssues(validation), validation);
    }

    const target = resolveTargetSet(graph, options);
    const layers = buildLayers(graph, target);
    const runId = `run-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const control = new RunControl();
    const states = new Map<string, NodeRunInfo>();
    for (const node of graph.nodes) {
      states.set(node.id, { nodeId: node.id, state: 'idle', attempt: 0 });
    }
    for (const nodeId of target) {
      const state = states.get(nodeId);
      if (state) state.state = 'queued';
    }

    const active: ActiveRun = {
      runId,
      graph,
      control,
      states,
      artifacts: new ArtifactStore(this.options.projectRoot, graph.id),
      incoming: buildIncomingMap(graph),
      target,
      options,
      failed: false,
      startedAt: Date.now(),
    };
    this.runs.set(runId, active);
    this.emit({ type: 'graph-run-start', payload: { runId, graphId: graph.id } });
    for (const [nodeId, state] of states) {
      if (state.state === 'queued') this.emitNodeState(nodeId, state);
    }

    let error: string | undefined;
    try {
      for (const layer of layers) {
        if (control.cancelled) break;
        await control.waitIfPaused();
        if (control.cancelled) break;
        const nodes = layer
          .map((nodeId) => graph.nodes.find((node) => node.id === nodeId))
          .filter((node): node is GraphNode => node !== undefined && target.has(node.id));
        const limit = Math.max(1, options.concurrency ?? this.options.concurrency ?? 3);
        await runWithConcurrency(nodes, limit, (node) => this.runNode(active, node));
        if (active.failed && (options.onError ?? 'stop') === 'stop') {
          break;
        }
      }
    } finally {
      this.rejectHumans(runId, '运行已结束');
      this.runs.delete(runId);
    }

    if (control.cancelled) {
      markUnfinished(active, 'cancelled');
    } else if (active.failed && (options.onError ?? 'stop') === 'stop') {
      markUnfinished(active, 'cancelled');
    }

    const status: GraphRunStatus = control.cancelled
      ? 'cancelled'
      : active.failed
        ? 'error'
        : 'success';
    if (active.failed) {
      error = firstError(active.states);
    }
    const endedAt = Date.now();
    const result: GraphRunResult = {
      runId,
      graphId: graph.id,
      status,
      startedAt: active.startedAt,
      endedAt,
      durationMs: endedAt - active.startedAt,
      nodes: Object.fromEntries(active.states),
      ...(error ? { error } : {}),
    };
    if (this.options.runStore) {
      try {
        await this.options.runStore.save(result);
      } catch (caught) {
        console.warn('[cocos-ai-agent] save run.json failed', caught);
      }
    }
    this.emit({
      type: 'graph-run-end',
      payload: { runId, status, durationMs: result.durationMs, ...(error ? { error } : {}) },
    });
    return result;
  }

  pause(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.control.pause();
    return true;
  }

  resume(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.control.resume();
    return true;
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    this.rejectHumans(runId, '运行已取消');
    run.control.cancel();
    return true;
  }

  respondHuman(id: string, result: HumanRunResult): boolean {
    const pending = this.humans.get(id);
    if (!pending) return false;
    this.humans.delete(id);
    this.removePendingListeners(pending);
    const state = pending.active.states.get(pending.nodeId);
    if (state && state.state === 'waiting-user') {
      state.state = 'running';
      this.emitNodeState(pending.nodeId, state);
    }
    this.emit({
      type: 'human-resolved',
      payload: { id, decision: result.decision, ...(result.feedback ? { feedback: result.feedback } : {}) },
    });
    pending.resolve(result);
    return true;
  }

  getActiveRunIds(): string[] {
    return [...this.runs.keys()];
  }

  private async runNode(active: ActiveRun, node: GraphNode): Promise<NodeRunInfo> {
    const state = active.states.get(node.id)!;
    await active.control.waitIfPaused();
    if (active.control.cancelled) {
      state.state = 'cancelled';
      this.finishNode(state);
      return state;
    }

    const definition = this.options.registry.get(node.type);
    if (!definition) {
      state.state = 'error';
      state.error = `未知节点类型：${node.type}`;
      active.failed = true;
      this.finishNode(state);
      return state;
    }

    const { inputs, missing } = this.resolveInputs(active, node, definition);
    if (node.disabled) {
      state.state = 'skipped';
      state.outputs = bypassOutputs(definition, inputs);
      const configuredPath = typeof node.params?.path === 'string' && node.params.path.trim();
      this.emitLog(
        node.id,
        configuredPath ? 'warn' : 'info',
        configuredPath
          ? '节点已禁用（旁路），配置的路径未参与运行；如需使用请取消“禁用”。'
          : '节点已禁用（旁路），已跳过。',
      );
      this.finishNode(state);
      this.emitNodeState(node.id, state);
      this.emitNodeOutput(active, node.id, state);
      return state;
    }
    if (missing.length) {
      state.state = 'skipped';
      state.error = `缺少上游输入：${missing.join('、')}`;
      state.attempt = 1;
      this.finishNode(state);
      this.emitNodeState(node.id, state);
      this.emitLog(node.id, 'warn', state.error);
      return state;
    }

    state.state = 'running';
    state.startedAt = Date.now();
    state.attempt = 0;
    this.emitNodeState(node.id, state);

    const cacheMode = nodeCacheMode(node, active.options);
    const cacheKey = cacheMode === 'off' ? '' : this.cacheKey(active.graph.id, node, inputs);
    if (cacheMode !== 'off' && cacheMode !== 'force' && cacheKey) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        state.state = 'success';
        state.cached = true;
        state.outputs = cloneJson(cached.outputs ?? {});
        state.artifacts = cloneJson(cached.artifacts ?? []);
        this.finishNode(state);
        this.emitNodeState(node.id, state);
        this.emitNodeOutput(active, node.id, state);
        this.emitLog(node.id, 'info', '缓存命中');
        return state;
      }
    }

    const retry = Math.max(0, Math.floor(nodeNumber(node.meta?.retry, active.options.retry ?? 0)));
    let lastError = '';
    for (let attempt = 0; attempt <= retry; attempt += 1) {
      state.attempt = attempt + 1;
      try {
        const result = await this.callNode(active, node, definition, inputs);
        state.state = 'success';
        state.outputs = result.outputs ?? {};
        state.artifacts = result.artifacts ?? [];
        state.error = undefined;
        this.finishNode(state);
        this.emitNodeState(node.id, state);
        this.emitNodeOutput(active, node.id, state);
        if (cacheKey && cacheMode !== 'off') {
          this.cache.set(cacheKey, cloneJson({ outputs: state.outputs, artifacts: state.artifacts }));
        }
        return state;
      } catch (caught) {
        if (active.control.cancelled) {
          state.state = 'cancelled';
          state.error = undefined;
          this.finishNode(state);
          this.emitNodeState(node.id, state);
          return state;
        }
        lastError = errorText(caught);
        this.emitLog(node.id, 'error', `节点失败（第 ${attempt + 1} 次）：${lastError}`);
        if (attempt < retry) {
          await sleep(250, active.control.signal);
          continue;
        }
      }
    }

    active.failed = true;
    const policy = errorPolicy(node, active.options);
    state.state = policy === 'skip' ? 'skipped' : 'error';
    state.error = lastError || '节点执行失败';
    this.finishNode(state);
    this.emitNodeState(node.id, state);
    return state;
  }

  private resolveInputs(
    active: ActiveRun,
    node: GraphNode,
    definition: NodeDefinition,
  ): { inputs: Record<string, unknown>; missing: string[] } {
    const inputDefs = new Map(definition.inputs.map((port) => [port.name, port]));
    const inputs: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const edge of active.incoming.get(node.id) ?? []) {
      const upstream = active.states.get(edge.from);
      const value = upstream?.outputs?.[edge.fromPort];
      const available =
        Boolean(upstream) &&
        (upstream!.state === 'success' || upstream!.state === 'skipped') &&
        value !== undefined;
      if (!available) {
        if (!edge.optional) missing.push(`${edge.from}.${edge.fromPort}`);
        continue;
      }
      const port = inputDefs.get(edge.toPort);
      if (port?.multiple) {
        const current = inputs[edge.toPort];
        const values = Array.isArray(current) ? current : [];
        values.push(value);
        inputs[edge.toPort] = values;
      } else if (inputs[edge.toPort] === undefined) {
        inputs[edge.toPort] = value;
      }
    }
    return { inputs, missing };
  }

  private async callNode(
    active: ActiveRun,
    node: GraphNode,
    definition: NodeDefinition,
    inputs: Record<string, unknown>,
  ): Promise<NodeResult> {
    const controller = new AbortController();
    const timeoutMs = Math.max(0, nodeNumber(node.meta?.timeoutMs, active.options.timeoutMs ?? 0));
    let timedOut = false;
    const onRunAbort = (): void => controller.abort();
    active.control.signal.addEventListener('abort', onRunAbort, { once: true });
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;

    const ctx: NodeRunContext = {
      runId: active.runId,
      graph: active.graph,
      node,
      params: node.params ?? {},
      inputs,
      signal: controller.signal,
      log: (level, message, data) => {
        this.emitLog(node.id, level, message, data);
      },
      stream: (kind, payload) => {
        this.emit({ type: 'node-stream', payload: { nodeId: node.id, kind, ...payload } });
      },
      writeArtifact: (input) => active.artifacts.write(active.runId, node.id, input),
      tool: (name, args = {}) => this.options.tool(name, args),
      agent: (request: AgentRunRequest) => {
        if (!this.options.agent) {
          throw new Error('Agent runtime 未注入，无法运行 Agent 节点。');
        }
        const agentRole = typeof node.params?.role === 'string' ? node.params.role : undefined;
        return this.options.agent(
          { ...request, agentType: node.type, ...(agentRole ? { agentRole } : {}) },
          controller.signal,
          (kind, payload) => {
            this.emit({ type: 'node-stream', payload: { nodeId: node.id, kind, ...payload } });
          },
        );
      },
      human: (request) => this.requestHuman(active, node, request),
    };

    try {
      return await Promise.race([
        definition.run(ctx),
        new Promise<never>((_, reject) => {
          const onAbort = (): void => {
            reject(new Error(timedOut ? `节点超时（${timeoutMs}ms）` : '运行已取消'));
          };
          if (controller.signal.aborted) {
            onAbort();
            return;
          }
          controller.signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      active.control.signal.removeEventListener('abort', onRunAbort);
    }
  }

  private requestHuman(active: ActiveRun, node: GraphNode, request: HumanRunRequest): Promise<HumanRunResult> {
    const id = `human-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    return new Promise<HumanRunResult>((resolve, reject) => {
      const state = active.states.get(node.id);
      if (state) {
        state.state = 'waiting-user';
        this.emitNodeState(node.id, state);
      }
      const timeoutMs = Math.max(0, request.timeoutMs ?? 0);
      const timer = timeoutMs
        ? setTimeout(() => {
            const pending = this.humans.get(id);
            if (!pending) return;
            this.humans.delete(id);
            this.removePendingListeners(pending);
            pending.reject(new Error(`等待用户超时（${timeoutMs}ms）`));
          }, timeoutMs)
        : null;
      const onAbort = (): void => {
        const pending = this.humans.get(id);
        if (!pending) return;
        this.humans.delete(id);
        this.removePendingListeners(pending);
        pending.reject(new Error('运行已取消'));
      };
      const pending: PendingHuman = {
        id,
        runId: active.runId,
        nodeId: node.id,
        active,
        timer,
        onAbort,
        resolve,
        reject,
      };
      this.humans.set(id, pending);
      active.control.signal.addEventListener('abort', onAbort, { once: true });
      this.emit({
        type: 'human-request',
        payload: {
          id,
          runId: active.runId,
          nodeId: node.id,
          title: request.title,
          ...(request.description ? { description: request.description } : {}),
          ...(request.kind ? { kind: request.kind } : {}),
          ...(request.options ? { options: request.options } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
          ...(request.payload !== undefined ? { payload: request.payload } : {}),
          at: Date.now(),
        },
      });
    });
  }

  private rejectHumans(runId: string, reason: string): void {
    for (const [id, pending] of [...this.humans]) {
      if (pending.runId !== runId) continue;
      this.humans.delete(id);
      this.removePendingListeners(pending);
      pending.reject(new Error(reason));
    }
  }

  private removePendingListeners(pending: PendingHuman): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.active.control.signal.removeEventListener('abort', pending.onAbort);
  }

  private cacheKey(graphId: string, node: GraphNode, inputs: Record<string, unknown>): string {
    return stableStringify({
      graph: graphId,
      type: node.type,
      params: node.params ?? {},
      inputs,
    });
  }

  private finishNode(state: NodeRunInfo): void {
    state.endedAt = Date.now();
    state.durationMs = state.startedAt ? state.endedAt - state.startedAt : 0;
  }

  private emitNodeState(nodeId: string, state: NodeRunInfo): void {
    this.emit({
      type: 'node-state',
      payload: {
        nodeId,
        state: state.state,
        attempt: state.attempt,
        ...(state.error ? { error: state.error } : {}),
        ...(state.startedAt ? { startedAt: state.startedAt } : {}),
        ...(state.durationMs !== undefined ? { durationMs: state.durationMs } : {}),
        ...(state.cached ? { cached: true } : {}),
      },
    });
  }

  private emitNodeOutput(active: ActiveRun, nodeId: string, state: NodeRunInfo): void {
    const artifacts = state.artifacts ?? [];
    this.emit({ type: 'node-output', payload: { runId: active.runId, nodeId, artifacts, outputs: state.outputs ?? {} } });
  }

  private emitLog(nodeId: string, level: string, message: string, data?: unknown): void {
    this.emit({
      type: 'node-log',
      payload: { nodeId, level, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  private emit(event: GraphEvent): void {
    try {
      this.options.event?.(event);
    } catch (error) {
      console.warn('[cocos-ai-agent] graph event sink failed', error);
    }
  }
}

class RunControl {
  private paused = false;
  private readonly waiters: Array<() => void> = [];
  private readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  cancel(): void {
    if (!this.controller.signal.aborted) this.controller.abort();
    this.resume();
  }

  async waitIfPaused(): Promise<void> {
    while (this.paused && !this.cancelled) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

function resolveTargetSet(graph: GraphDocument, options: GraphRunOptions): Set<string> {
  const allIds = new Set(graph.nodes.map((node) => node.id));
  const mode = options.mode ?? 'all';
  if (mode === 'all') return allIds;

  const targetNodeId = options.targetNodeId;
  if (!targetNodeId || !allIds.has(targetNodeId)) {
    throw new GraphError('GRAPH_NODE_NOT_FOUND', `找不到目标节点：${targetNodeId ?? '(未指定)'}`);
  }

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (incoming.has(edge.to.node) && outgoing.has(edge.from.node)) {
      incoming.get(edge.to.node)!.push(edge.from.node);
      outgoing.get(edge.from.node)!.push(edge.to.node);
    }
  }

  const selected = new Set<string>([targetNodeId]);
  const addAncestors = (nodeId: string): void => {
    for (const parent of incoming.get(nodeId) ?? []) {
      if (selected.has(parent)) continue;
      selected.add(parent);
      addAncestors(parent);
    }
  };
  addAncestors(targetNodeId);

  if (mode === 'from') {
    const descendants = new Set<string>();
    const visit = (nodeId: string): void => {
      for (const child of outgoing.get(nodeId) ?? []) {
        if (descendants.has(child)) continue;
        descendants.add(child);
        visit(child);
      }
    };
    visit(targetNodeId);
    for (const nodeId of descendants) {
      selected.add(nodeId);
      addAncestors(nodeId);
    }
  }
  return selected;
}

function buildLayers(graph: GraphDocument, target: Set<string>): string[][] {
  const nodes = graph.nodes.filter((node) => target.has(node.id));
  if (!nodes.length) return [];
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!target.has(edge.from.node) || !target.has(edge.to.node)) continue;
    outgoing.get(edge.from.node)?.push(edge.to.node);
    indegree.set(edge.to.node, (indegree.get(edge.to.node) ?? 0) + 1);
  }

  const level = new Map<string, number>();
  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  for (const nodeId of queue) level.set(nodeId, 0);
  let processed = 0;
  while (queue.length) {
    const current = queue.shift()!;
    processed += 1;
    const currentLevel = level.get(current) ?? 0;
    for (const next of outgoing.get(current) ?? []) {
      level.set(next, Math.max(level.get(next) ?? 0, currentLevel + 1));
      const nextDegree = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) queue.push(next);
    }
  }
  if (processed < nodes.length) {
    throw new GraphError('GRAPH_LOOP_UNSUPPORTED', '当前图包含环；loop/subgraph 循环将在 G5.7 支持。');
  }
  const layers: string[][] = [];
  for (const node of nodes) {
    const index = level.get(node.id) ?? 0;
    (layers[index] ??= []).push(node.id);
  }
  return layers.filter((layer) => layer.length > 0);
}

function buildIncomingMap(graph: GraphDocument): Map<string, IncomingEdge[]> {
  const map = new Map<string, IncomingEdge[]>();
  for (const node of graph.nodes) map.set(node.id, []);
  for (const edge of graph.edges) {
    const list = map.get(edge.to.node);
    if (!list) continue;
    list.push({
      from: edge.from.node,
      fromPort: edge.from.port,
      toPort: edge.to.port,
      optional: Boolean(edge.optional),
    });
  }
  return map;
}

function bypassOutputs(definition: NodeDefinition, inputs: Record<string, unknown>): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const output of definition.outputs) {
    const candidate =
      definition.inputs.find((input) => input.name === output.name && inputs[input.name] !== undefined) ??
      definition.inputs.find((input) => input.type === output.type && inputs[input.name] !== undefined) ??
      definition.inputs.find((input) => inputs[input.name] !== undefined);
    outputs[output.name] = candidate ? inputs[candidate.name] : undefined;
  }
  return outputs;
}

function nodeCacheMode(node: GraphNode, options: GraphRunOptions): 'auto' | 'off' | 'force' {
  const value = node.meta?.cache;
  if (value === 'off' || value === 'force' || value === 'auto') return value;
  return options.cache ?? 'auto';
}

function errorPolicy(node: GraphNode, options: GraphRunOptions): 'stop' | 'continue' | 'skip' {
  const value = node.meta?.onError;
  if (value === 'stop' || value === 'continue' || value === 'skip') return value;
  return options.onError ?? 'stop';
}

function markUnfinished(active: ActiveRun, state: 'cancelled'): void {
  for (const nodeId of active.target) {
    const nodeState = active.states.get(nodeId);
    if (!nodeState) continue;
    if (nodeState.state === 'queued' || nodeState.state === 'idle') {
      nodeState.state = state;
      nodeState.endedAt = Date.now();
      nodeState.durationMs = 0;
      active.states.set(nodeId, nodeState);
    }
  }
}

function firstError(states: Map<string, NodeRunInfo>): string | undefined {
  for (const state of states.values()) {
    if (state.error && (state.state === 'error' || state.state === 'skipped')) return state.error;
  }
  return undefined;
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function nodeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object') return item;
    if (seen.has(item)) return '[Circular]';
    seen.add(item);
    if (Array.isArray(item)) return item.map(normalize);
    const record = item as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = normalize(record[key]);
    return sorted;
  };
  try {
    return JSON.stringify(normalize(value));
  } catch {
    return String(value);
  }
}

function cloneJson<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
