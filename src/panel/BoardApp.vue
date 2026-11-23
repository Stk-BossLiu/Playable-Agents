<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { GraphDocument, GraphEdge, GraphNode, GraphSummary } from '../shared/graph';
import type { ModelProfileView, ModelProfilesDTO } from '../shared/models';
import { request, requestRetry } from './api';
import { locale, t } from './i18n';
import { setToast, state } from './store';
import ViewTabs from './components/ViewTabs.vue';
import ApprovalBar from './components/ApprovalBar.vue';

interface ParamSchema {
  type?: string;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  items?: { type?: string };
}

interface PortInfo {
  name: string;
  type: string;
  required?: boolean;
  multiple?: boolean;
  description?: string;
}

interface NodeTypeInfo {
  type: string;
  category: string;
  label: string;
  description: string;
  inputs: PortInfo[];
  outputs: PortInfo[];
  paramsSchema?: { properties?: Record<string, ParamSchema> };
  uiSchema?: Record<string, { control?: string; rows?: number }>;
}

interface PendingFrom {
  node: string;
  port: string;
  type: string;
}

interface PortHit {
  nodeId: string;
  port: string;
  direction: 'in' | 'out';
  type: string;
  compatible?: boolean;
}

interface ContextMenuState {
  x: number;
  y: number;
  worldX: number;
  worldY: number;
}

/** 节点卡内部布局常量，必须与 styles.css 中 .node-head/.port-row 的高度保持一致。 */
const NODE_HEAD_HEIGHT = 28;
const NODE_PORT_PADDING = 6;
const NODE_PORT_ROW = 22;
const NODE_FOOT_HEIGHT = 20;
const NODE_MIN_HEIGHT = 132;
/** 端口圆点中心到节点外边缘的距离（边框 1 + 内边距 6 + 圆点半径 3.5）。 */
const PORT_DOT_INSET = 10.5;

const VIDEO_FILE_RE = /\.(mp4|m4v|mov|webm|mkv|avi|flv|wmv|ogv|mpeg|mpg)$/i;
const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif|bmp|tga|svg|psd)$/i;

const CATEGORY_LABELS: Record<string, [zh: string, en: string]> = {
  source: ['输入', 'Source'],
  media: ['媒体', 'Media'],
  analysis: ['分析', 'Analysis'],
  agent: ['Agent', 'Agent'],
  logic: ['逻辑', 'Logic'],
  human: ['人工', 'Human'],
  output: ['输出', 'Output'],
  tool: ['工具', 'Tool'],
  subgraph: ['子图', 'Subgraph'],
};

function categoryLabel(category: string): string {
  const entry = CATEGORY_LABELS[category];
  if (!entry) return category;
  return locale === 'zh' ? entry[0] : entry[1];
}

defineProps<{ embedded?: boolean }>();

const graphs = ref<GraphSummary[]>([]);
const nodeTypes = ref<NodeTypeInfo[]>([]);
const modelProfiles = ref<ModelProfileView[]>([]);
const current = ref<GraphDocument | null>(null);
const builtin = ref(false);
const selectedId = ref('');
const addType = ref('');
const newName = ref('');
const loading = ref(false);
const error = ref('');
const dirty = ref(false);
const pendingFrom = ref<PendingFrom | null>(null);
const canvasEl = ref<HTMLElement | null>(null);
const dragState = reactive<{ nodeId: string; dx: number; dy: number }>({ nodeId: '', dx: 0, dy: 0 });
const pan = reactive({ x: 0, y: 0 });
const zoom = ref(1);
const panState = reactive({
  active: false,
  startX: 0,
  startY: 0,
  startPanX: 0,
  startPanY: 0,
  moved: false,
});
const artifactPreview = ref<{ name: string; mime: string; encoding: string; content: string } | null>(null);
const artifactLoading = ref(false);
const contextMenu = ref<ContextMenuState | null>(null);
const contextFilter = ref('');
const contextSearchEl = ref<HTMLInputElement | null>(null);
const dropNodeId = ref('');
const dropParamKey = ref('');
const canvasDropActive = ref(false);
const connectDrag = reactive({
  active: false,
  nodeId: '',
  port: '',
  type: 'any',
  direction: 'out' as 'in' | 'out',
  startClientX: 0,
  startClientY: 0,
  pointerX: 0,
  pointerY: 0,
  moved: false,
  hover: null as PortHit | null,
});

const canvasInnerStyle = computed(() => ({
  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom.value})`,
  width: '2400px',
  height: '1400px',
}));
const canvasBgStyle = computed(() => ({
  backgroundPosition: `${pan.x}px ${pan.y}px`,
  backgroundSize: `${24 * zoom.value}px ${24 * zoom.value}px`,
}));

const selected = computed(() => current.value?.nodes.find((node) => node.id === selectedId.value) ?? null);
const selectedType = computed(() => nodeTypes.value.find((type) => type.type === selected.value?.type) ?? null);
const selectedParams = computed(() => (selected.value?.params ?? {}) as Record<string, unknown>);
const paramEntries = computed(() => {
  const properties = selectedType.value?.paramsSchema?.properties ?? {};
  return Object.entries(properties).map(([key, schema]) => ({ key, schema }));
});
const canEdit = computed(() => Boolean(current.value) && !builtin.value);
const runStatus = computed(() => state.graphRun.status);
const selectedInputs = computed(() => selectedType.value?.inputs ?? []);
const filteredNodeTypes = computed(() => {
  const query = contextFilter.value.trim().toLowerCase();
  const groups = new Map<string, NodeTypeInfo[]>();
  for (const type of nodeTypes.value) {
    if (
      query &&
      !`${type.label} ${type.type} ${type.category} ${type.description}`.toLowerCase().includes(query)
    ) {
      continue;
    }
    const list = groups.get(type.category) ?? [];
    list.push(type);
    groups.set(type.category, list);
  }
  return [...groups.entries()].map(([category, types]) => ({ category, types }));
});
const tempEdgePath = computed(() => {
  if (!connectDrag.active) return '';
  const node = current.value?.nodes.find((item) => item.id === connectDrag.nodeId);
  if (!node) return '';
  if (connectDrag.direction === 'out') {
    return bezierPath(
      portX(node, 'out'),
      portY(node, connectDrag.port, 'out'),
      connectDrag.pointerX,
      connectDrag.pointerY,
    );
  }
  return bezierPath(
    connectDrag.pointerX,
    connectDrag.pointerY,
    portX(node, 'in'),
    portY(node, connectDrag.port, 'in'),
  );
});

onMounted(async () => {
  await Promise.all([refreshGraphs(), loadNodeTypes(), loadModelProfiles()]);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('dragend', clearDropHints);
  window.addEventListener('drop', clearDropHints);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('pointermove', panMove);
  window.removeEventListener('pointerup', panEnd);
  window.removeEventListener('pointermove', connectMove);
  window.removeEventListener('pointerup', connectEnd);
  window.removeEventListener('dragend', clearDropHints);
  window.removeEventListener('drop', clearDropHints);
  closeContextMenu();
});

/** Shadow DOM 内的事件冒泡到 window 时 target 会被重定向为宿主元素，改为读取 composedPath。 */
function composedTarget(event: Event): HTMLElement | null {
  for (const item of event.composedPath()) {
    if (item instanceof HTMLElement) return item;
  }
  return (event.target as HTMLElement | null) ?? null;
}

function isEditableEvent(event: Event): boolean {
  for (const item of event.composedPath()) {
    if (!(item instanceof HTMLElement)) continue;
    const tag = item.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (item.isContentEditable) return true;
  }
  return false;
}

/**
 * 组件根节点上的 keydown 兜底：同一 Shadow 树内 event.target 一定是真实元素。
 * 输入框里的 Backspace/Delete 在这里就阻止冒泡，避免 window 监听器在 Shadow DOM
 * 事件重定向（target 变成宿主 div）时误判为“画布上的删除键”。
 */
function onBoardKeyDown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName?.toLowerCase();
  const editable = tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(target?.isContentEditable);
  if (!editable) return;
  if (event.key === 'Escape' && contextMenu.value) closeContextMenu();
  if (event.key === 'Delete' || event.key === 'Backspace' || event.key === 'Escape') {
    event.stopPropagation();
  }
}

function onKeyDown(event: KeyboardEvent): void {
  // IME 合成过程中的按键（例如输入法里的 Backspace）不参与快捷键。
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape') {
    if (contextMenu.value) {
      event.preventDefault();
      closeContextMenu();
      return;
    }
    if (connectDrag.active) {
      event.preventDefault();
      cancelConnect();
      return;
    }
    if (isEditableEvent(event)) return;
    pendingFrom.value = null;
    selectedId.value = '';
    return;
  }
  // 在输入框 / 文本域 / 下拉框中按 Backspace/Delete 时绝不能删除节点。
  if (isEditableEvent(event)) return;
  if (event.key !== 'Delete' && event.key !== 'Backspace') return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (!selectedId.value) return;
  event.preventDefault();
  deleteSelected();
}

async function refreshGraphs(): Promise<void> {
  try {
    graphs.value = await requestRetry<GraphSummary[]>('graph-list');
    if (!current.value) {
      const blank = graphs.value.find((graph) => graph.builtin && graph.id === 'blank') ?? graphs.value[0];
      if (blank) await openGraph(blank);
    }
  } catch (caught) {
    error.value = errorText(caught);
  }
}

async function loadNodeTypes(): Promise<void> {
  try {
    nodeTypes.value = await requestRetry<NodeTypeInfo[]>('graph-node-types');
    if (!addType.value && nodeTypes.value.length) addType.value = nodeTypes.value[0].type;
  } catch (caught) {
    error.value = errorText(caught);
  }
}

/** 加载插件配置里的模型列表，用于节点 provider/model/modelProfileId 下拉。 */
async function loadModelProfiles(): Promise<void> {
  try {
    const dto = await requestRetry<ModelProfilesDTO>('model-profiles-get');
    modelProfiles.value = dto.profiles;
  } catch {
    // 模型配置不可用时退回普通文本输入
    modelProfiles.value = [];
  }
}

async function openGraph(summary: GraphSummary): Promise<void> {
  loading.value = true;
  error.value = '';
  closeContextMenu();
  try {
    const loaded = await request<{ graph: GraphDocument; builtin: boolean }>('graph-load', { id: summary.id });
    current.value = normalizeGraph(loaded.graph);
    builtin.value = loaded.builtin;
    selectedId.value = '';
    pendingFrom.value = null;
    dirty.value = false;
    state.graphRun = { runId: '', status: 'idle', nodes: {}, logs: [], artifacts: {} };
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    loading.value = false;
  }
}

function normalizeGraph(document: GraphDocument): GraphDocument {
  const graph = JSON.parse(JSON.stringify(document)) as GraphDocument;
  graph.nodes = graph.nodes.map((node, index) => ({
    ...node,
    position: node.position ?? { x: 60 + (index % 3) * 280, y: 60 + Math.floor(index / 3) * 170 },
    params: node.params ?? {},
  }));
  return graph;
}

async function saveGraph(): Promise<void> {
  if (!current.value) return;
  if (builtin.value) {
    setToast('warn', t('board.readonly'));
    return;
  }
  try {
    const saved = await request<{ graph: GraphDocument }>('graph-save', { graph: plainGraph() });
    current.value = normalizeGraph(saved.graph);
    builtin.value = false;
    dirty.value = false;
    setToast('success', t('board.saved'));
    await refreshGraphs();
  } catch (caught) {
    error.value = errorText(caught);
  }
}

async function duplicateGraph(): Promise<void> {
  if (!current.value) return;
  try {
    const copied = await request<{ graph: GraphDocument }>('graph-duplicate', { id: current.value.id });
    current.value = normalizeGraph(copied.graph);
    builtin.value = false;
    selectedId.value = '';
    dirty.value = false;
    setToast('success', copied.graph.name);
    await refreshGraphs();
  } catch (caught) {
    error.value = errorText(caught);
  }
}

async function deleteGraph(graph: GraphSummary): Promise<void> {
  if (graph.builtin) {
    setToast('warn', t('board.readonly'));
    return;
  }
  const confirmed = window.confirm(t('board.deleteConfirm', { name: graph.name }));
  if (!confirmed) return;
  try {
    await request('graph-delete', { id: graph.id });
    if (current.value?.id === graph.id) {
      current.value = null;
      builtin.value = false;
      selectedId.value = '';
      pendingFrom.value = null;
    }
    await refreshGraphs();
    setToast('success', t('board.deleted', { name: graph.name }));
  } catch (caught) {
    error.value = errorText(caught);
  }
}

async function createGraph(): Promise<void> {
  const name = newName.value.trim();
  if (!name) return;
  try {
    const id = `${slug(name)}-${Date.now().toString(36)}`;
    const created = await request<{ graph: GraphDocument }>('graph-create', { id, name });
    current.value = normalizeGraph(created.graph);
    builtin.value = false;
    selectedId.value = '';
    newName.value = '';
    dirty.value = false;
    await refreshGraphs();
  } catch (caught) {
    error.value = errorText(caught);
  }
}

function addNode(): void {
  if (!current.value) return;
  const index = current.value.nodes.length;
  addNodeAt({ x: 60 + (index % 3) * 280, y: 60 + Math.floor(index / 3) * 170 });
}

function addNodeAt(
  position: { x: number; y: number },
  typeOverride?: NodeTypeInfo,
  paramsOverride?: Record<string, unknown>,
): void {
  if (!current.value) return;
  if (builtin.value) {
    setToast('warn', t('board.readonly'));
    return;
  }
  const type = typeOverride ?? nodeTypes.value.find((item) => item.type === addType.value);
  if (!type) return;
  const node: GraphNode = {
    id: `node-${Date.now().toString(36)}`,
    type: type.type,
    title: type.label,
    position: { x: Math.max(0, position.x), y: Math.max(0, position.y) },
    params: { ...defaultParams(type), ...(paramsOverride ?? {}) },
  };
  current.value.nodes.push(node);
  selectedId.value = node.id;
  dirty.value = true;
}

function defaultParams(type: NodeTypeInfo): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(type.paramsSchema?.properties ?? {})) {
    if (schema.default !== undefined) params[key] = schema.default;
    else if (schema.enum?.length) params[key] = schema.enum[0];
    else if (schema.type === 'boolean') params[key] = false;
  }
  return params;
}

/* ---------- 拖入文件（视频 / 图片 / 任意文件） ---------- */

/**
 * 判断是否值得接手的拖拽：
 * - 系统文件（Files / text/uri-list）
 * - Cocos 资源管理器拖拽（自定义类型 + value，或只有 Editor.UI.DragArea.currentDragInfo）
 * - 类型被浏览器隐藏时也先接下，drop 时再解析（避免资源拖拽因 types 为空被漏掉）
 * 纯文本拖拽放行给输入框的原生行为。
 */
function isDropPayload(event: DragEvent): boolean {
  const types = event.dataTransfer ? Array.from(event.dataTransfer.types) : [];
  return !(types.length > 0 && types.every((type) => type === 'text/plain' || type === 'text/html'));
}

function onRootDragOver(event: DragEvent): void {
  if (isDropPayload(event)) event.preventDefault();
}

function onRootDrop(event: DragEvent): void {
  clearDropHints();
  if (isDropPayload(event)) event.preventDefault();
}

function clearDropHints(): void {
  dropNodeId.value = '';
  dropParamKey.value = '';
  canvasDropActive.value = false;
}

function onRootDragLeave(event: DragEvent): void {
  if (!event.relatedTarget) clearDropHints();
}

function dragOverNode(event: DragEvent, node: GraphNode): void {
  if (!canEdit.value || !isDropPayload(event)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  dropNodeId.value = node.id;
  dropParamKey.value = '';
  canvasDropActive.value = false;
}

function dragTypeSummary(event: DragEvent): string {
  const types = event.dataTransfer ? Array.from(event.dataTransfer.types) : [];
  return types.length ? types.join(', ') : '—';
}

function dragLeaveNode(event: DragEvent): void {
  const current = event.currentTarget as HTMLElement | null;
  const related = event.relatedTarget as Node | null;
  if (current && related && current.contains(related)) return;
  dropNodeId.value = '';
}

async function dropOnNode(event: DragEvent, node: GraphNode): Promise<void> {
  if (!isDropPayload(event)) return;
  event.preventDefault();
  event.stopPropagation();
  clearDropHints();
  if (!canEdit.value) {
    setToast('warn', t('board.readonly'));
    return;
  }
  const paths = await droppedPaths(event);
  if (!paths.length) {
    setToast('warn', t('board.dropPathMissing', { types: dragTypeSummary(event) }));
    return;
  }
  if (!assignPathsToNode(node, paths)) {
    setToast('warn', t('board.dropUnsupported'));
    return;
  }
  selectedId.value = node.id;
  dirty.value = true;
  setToast('success', t('board.dropped', { count: paths.length }));
}

/** 把拖入文件的路径写入节点：input.video/file 用 path，input.images 追加 images。 */
function assignPathsToNode(node: GraphNode, paths: string[]): boolean {
  const type = nodeTypeOf(node);
  if (type && type.category !== 'source' && !node.type.startsWith('input.')) return false;
  const props = type?.paramsSchema?.properties ?? {};
  const params: Record<string, unknown> = { ...(node.params ?? {}) };
  const videos = paths.filter((path) => VIDEO_FILE_RE.test(path));
  const images = paths.filter((path) => IMAGE_FILE_RE.test(path));
  if ('images' in props || node.type === 'input.images') {
    if (!images.length) return false;
    const current = Array.isArray(params.images)
      ? (params.images as unknown[]).filter((item): item is string => typeof item === 'string')
      : [];
    params.images = uniquePaths([...current, ...images]);
  } else if ('path' in props) {
    const path = videos[0] ?? paths[0];
    const previousPath = typeof params.path === 'string' ? params.path : '';
    const previousName = typeof params.name === 'string' ? params.name : '';
    params.path = path;
    // 显示名是自动填的（或为空）时跟着新文件更新，用户自定义过的名称保持不动。
    if ('name' in props && (!previousName || previousName === fileNameOf(previousPath))) {
      params.name = fileNameOf(path);
    }
  } else {
    return false;
  }
  node.params = params;
  // 填入文件本身就是“要使用这个节点”的明确动作，自动取消禁用/旁路。
  node.disabled = false;
  return true;
}

function dragOverCanvas(event: DragEvent): void {
  if (!isDropPayload(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  if (!canEdit.value) return;
  canvasDropActive.value = true;
  dropNodeId.value = '';
  dropParamKey.value = '';
}

function dragLeaveCanvas(event: DragEvent): void {
  const current = event.currentTarget as HTMLElement | null;
  const related = event.relatedTarget as Node | null;
  if (current && related && current.contains(related)) return;
  canvasDropActive.value = false;
}

/** 拖到空白画布：按文件类型自动创建 input.video / input.images / input.file 节点。 */
async function dropOnCanvas(event: DragEvent): Promise<void> {
  if (!isDropPayload(event)) return;
  event.preventDefault();
  event.stopPropagation();
  clearDropHints();
  if (!canEdit.value) {
    if (current.value) setToast('warn', t('board.readonly'));
    return;
  }
  const paths = await droppedPaths(event);
  if (!paths.length) {
    setToast('warn', t('board.dropPathMissing', { types: dragTypeSummary(event) }));
    return;
  }
  const point = screenToWorld(event.clientX, event.clientY);
  const plan: Array<{ type: string; params: Record<string, unknown>; offset: number }> = [];
  const images = paths.filter((path) => IMAGE_FILE_RE.test(path));
  if (images.length === paths.length) {
    plan.push({ type: 'input.images', params: { images: uniquePaths(images) }, offset: 0 });
  } else {
    paths.forEach((path, index) => {
      if (IMAGE_FILE_RE.test(path)) {
        plan.push({ type: 'input.images', params: { images: [path] }, offset: index });
      } else if (VIDEO_FILE_RE.test(path)) {
        plan.push({ type: 'input.video', params: { path, name: fileNameOf(path) }, offset: index });
      } else {
        plan.push({ type: 'input.file', params: { path, name: fileNameOf(path) }, offset: index });
      }
    });
  }
  let added = 0;
  for (const item of plan) {
    const nodeType = nodeTypes.value.find((entry) => entry.type === item.type);
    if (!nodeType) continue;
    addNodeAt(
      { x: point.x + item.offset * 26, y: point.y + item.offset * 26 },
      nodeType,
      item.params,
    );
    added += 1;
  }
  if (!added) {
    setToast('warn', t('board.dropUnsupported'));
    return;
  }
  setToast('success', t('board.dropped', { count: paths.length }));
}

function dragOverParam(key: string, event: DragEvent): void {
  if (!canEdit.value || !isDropPayload(event)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  dropParamKey.value = key;
  dropNodeId.value = '';
  canvasDropActive.value = false;
}

function dragLeaveParam(key: string, event: DragEvent): void {
  const current = event.currentTarget as HTMLElement | null;
  const related = event.relatedTarget as Node | null;
  if (current && related && current.contains(related)) return;
  if (dropParamKey.value === key) dropParamKey.value = '';
}

/** 拖到检查器里的某个输入框：字符串填入路径，数组（如图片列表）追加。 */
async function dropOnParam(event: DragEvent, key: string): Promise<void> {
  if (!isDropPayload(event)) return;
  event.preventDefault();
  event.stopPropagation();
  clearDropHints();
  if (!canEdit.value) {
    setToast('warn', t('board.readonly'));
    return;
  }
  const node = selected.value;
  if (!node) return;
  const paths = await droppedPaths(event);
  if (!paths.length) {
    setToast('warn', t('board.dropPathMissing', { types: dragTypeSummary(event) }));
    return;
  }
  const schema = selectedType.value?.paramsSchema?.properties?.[key];
  const kind = schema?.type;
  if (kind === 'boolean' || kind === 'number' || kind === 'object') {
    setToast('warn', t('board.dropUnsupported'));
    return;
  }
  if (kind === 'array' || Array.isArray(selectedParams.value[key])) {
    const current = Array.isArray(selectedParams.value[key])
      ? (selectedParams.value[key] as unknown[]).filter((item): item is string => typeof item === 'string')
      : [];
    setParam(key, uniquePaths([...current, ...paths]));
  } else {
    setParam(key, paths[0]);
  }
  if (schema && isFileParam(key, schema)) node.disabled = false;
  setToast('success', t('board.dropped', { count: paths.length }));
}

async function droppedPaths(event: DragEvent): Promise<string[]> {
  const transfer = event.dataTransfer;
  if (!transfer) return [];
  // 1) 系统文件：Windows 资源管理器 / 桌面拖入
  const fromFiles = Array.from(transfer.files ?? [])
    .map(filePathOf)
    .filter((path): path is string => Boolean(path));
  if (fromFiles.length) return uniquePaths(fromFiles);
  // 2) 文本形式的路径：file:// / db:// / 绝对路径
  const textPaths = parseDroppedText(
    `${safeGetData(transfer, 'text/uri-list')}\n${safeGetData(transfer, 'text/plain')}`,
  );
  if (textPaths.length) return uniquePaths(textPaths);
  // 3) Cocos 资源管理器拖拽：ui-drag-item 用自定义类型 + value（资源 uuid）
  const candidates = dragValueCandidates(transfer);
  if (!candidates.length) return [];
  const resolved: string[] = [];
  for (const candidate of candidates) {
    const path = await resolveDragValue(candidate);
    if (path) resolved.push(path);
  }
  return uniquePaths(resolved);
}

function safeGetData(transfer: DataTransfer, type: string): string {
  try {
    return transfer.getData(type) ?? '';
  } catch {
    return '';
  }
}

function editorDragInfo(): { value?: unknown; additional?: unknown } | null {
  try {
    const info = (Editor as unknown as {
      UI?: { DragArea?: { currentDragInfo?: { value?: unknown; additional?: unknown } | null } };
    }).UI?.DragArea?.currentDragInfo;
    return info && typeof info === 'object' ? info : null;
  } catch {
    return null;
  }
}

/** 收集拖拽载荷里可能的资源标识（uuid / db:// 路径）。 */
function dragValueCandidates(transfer: DataTransfer): string[] {
  const values: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (!text) return;
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        collectDragValues(JSON.parse(text), values);
        return;
      } catch {
        // 不是 JSON，按原值处理
      }
    }
    values.push(text);
  };
  push(safeGetData(transfer, 'value'));
  push(safeGetData(transfer, 'assetUuid'));
  push(safeGetData(transfer, 'uuid'));
  for (const type of Array.from(transfer.types)) {
    if (type === 'Files' || type === 'text/plain' || type === 'text/uri-list') continue;
    push(safeGetData(transfer, type));
  }
  const info = editorDragInfo();
  if (info) {
    collectDragValues(info.value, values);
    collectDragValues(info.additional, values);
    // 兼容 currentDragInfo 本身是 {type,value} 或数组的情况
    collectDragValues(info, values);
  }
  return uniquePaths(values);
}

function collectDragValues(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text) out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDragValues(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['value', 'uuid', 'url', 'path', 'file']) {
      if (typeof record[key] === 'string' && record[key]) out.push(record[key] as string);
    }
  }
}

/** uuid → 资源绝对路径（asset-db.query-asset-info 的 file 字段）。 */
async function resolveDragValue(value: string): Promise<string> {
  const text = value.trim();
  if (!text) return '';
  // 已经是文件系统路径或 http(s) URL 时直接使用
  if (isDirectPath(text)) return normalizeDroppedPath(text);
  // 子资源的 uuid 形如 mainUuid@subUuid，主 uuid 对应的 file 就是源文件。
  const candidates = [text];
  const mainUuid = text.split('@')[0];
  if (mainUuid && mainUuid !== text) candidates.push(mainUuid);
  for (const candidate of candidates) {
    try {
      const info = await editorRequest<{ file?: string; url?: string } | null>(
        'asset-db',
        'query-asset-info',
        candidate,
        ['file', 'url', 'name', 'type'],
      );
      if (info?.file) return info.file;
      if (candidate === text && info?.url) return info.url;
    } catch {
      // asset-db 不可用时尝试下一个候选
    }
  }
  // db:// 资源查询失败时保留 url 作为兜底
  return text.startsWith('db://') ? text : '';
}

function isDirectPath(value: string): boolean {
  return (
    /^(file:\/\/|[a-zA-Z]:[\\/]|\/|\\\\)/.test(value) || /^https?:\/\//i.test(value)
  );
}

async function editorRequest<T>(target: string, message: string, ...args: unknown[]): Promise<T> {
  return (
    Editor.Message.request as unknown as (
      target: string,
      message: string,
      ...rest: unknown[]
    ) => Promise<T>
  )(target, message, ...args);
}

/** Electron 31 仍提供 file.path；新版本回退到 webUtils.getPathForFile。 */
function filePathOf(file: File): string {
  const legacy = (file as File & { path?: string }).path;
  if (typeof legacy === 'string' && legacy) return legacy;
  try {
    const req =
      typeof require === 'function'
        ? require
        : (window as unknown as { require?: NodeRequire }).require;
    const electron = req?.('electron') as
      | { webUtils?: { getPathForFile?: (file: File) => string } }
      | undefined;
    return electron?.webUtils?.getPathForFile?.(file) ?? '';
  } catch {
    return '';
  }
}

function parseDroppedText(raw: string): string[] {
  const paths: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const path = normalizeDroppedPath(value);
    if (looksLikePath(path)) paths.push(path);
  }
  return paths;
}

function normalizeDroppedPath(value: string): string {
  if (!/^file:\/\//i.test(value)) return value;
  let path = value.replace(/^file:\/\//i, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    // 保留原值
  }
  return path.replace(/^\/+([a-zA-Z]:[\\/])/, '$1');
}

function looksLikePath(value: string): boolean {
  return /^(db:\/\/|[a-zA-Z]:[\\/]|\/|\\\\)/.test(value) || /^(https?|file):\/\//i.test(value);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}

function fileNameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
}

function deleteSelected(): void {
  if (!current.value || !selected.value || builtin.value) return;
  const id = selected.value.id;
  current.value.nodes = current.value.nodes.filter((node) => node.id !== id);
  current.value.edges = current.value.edges.filter((edge) => edge.from.node !== id && edge.to.node !== id);
  selectedId.value = '';
  pendingFrom.value = null;
  dirty.value = true;
}

function selectNode(node: GraphNode): void {
  blurActiveEdit();
  selectedId.value = node.id;
  // 选中 Agent 节点时刷新模型列表，确保状态页刚添加的模型能立即出现在下拉里。
  const props = nodeTypeOf(node)?.paramsSchema?.properties ?? {};
  if ('modelProfileId' in props || 'visionProfileId' in props || 'provider' in props || 'model' in props) {
    void loadModelProfiles();
  }
}

/** 点击画布/节点时收起输入焦点，之后按 Delete 才能删除选中节点。 */
function blurActiveEdit(): void {
  let active = document.activeElement as HTMLElement | null;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement as HTMLElement;
  }
  if (!active) return;
  const tag = active.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || active.isContentEditable) active.blur();
}

function dragStart(event: PointerEvent, node: GraphNode): void {
  if (!canEdit.value) return;
  event.preventDefault();
  selectNode(node);
  const point = screenToWorld(event.clientX, event.clientY);
  dragState.nodeId = node.id;
  dragState.dx = point.x - node.position.x;
  dragState.dy = point.y - node.position.y;
  window.addEventListener('pointermove', dragMove);
  window.addEventListener('pointerup', dragEnd, { once: true });
}

function dragMove(event: PointerEvent): void {
  if (!dragState.nodeId || !current.value) return;
  const node = current.value.nodes.find((item) => item.id === dragState.nodeId);
  if (!node) return;
  const point = screenToWorld(event.clientX, event.clientY);
  node.position = {
    x: Math.max(0, point.x - dragState.dx),
    y: Math.max(0, point.y - dragState.dy),
  };
  dirty.value = true;
}

function dragEnd(): void {
  window.removeEventListener('pointermove', dragMove);
  dragState.nodeId = '';
}

function viewportPoint(clientX: number, clientY: number): { x: number; y: number } {
  const canvas = canvasEl.value;
  if (!canvas) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
  const point = viewportPoint(clientX, clientY);
  return {
    x: (point.x - pan.x) / zoom.value,
    y: (point.y - pan.y) / zoom.value,
  };
}

function canvasPointerDown(event: PointerEvent): void {
  if (event.button !== 0 && event.button !== 1) return;
  if (composedTarget(event)?.closest('.board-node')) return;
  blurActiveEdit();
  panState.active = true;
  panState.moved = false;
  panState.startX = event.clientX;
  panState.startY = event.clientY;
  panState.startPanX = pan.x;
  panState.startPanY = pan.y;
  window.addEventListener('pointermove', panMove);
  window.addEventListener('pointerup', panEnd, { once: true });
}

function panMove(event: PointerEvent): void {
  if (!panState.active) return;
  const dx = event.clientX - panState.startX;
  const dy = event.clientY - panState.startY;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panState.moved = true;
  pan.x = panState.startPanX + dx;
  pan.y = panState.startPanY + dy;
}

function panEnd(): void {
  window.removeEventListener('pointermove', panMove);
  if (panState.active && !panState.moved) {
    selectedId.value = '';
    pendingFrom.value = null;
  }
  panState.active = false;
}

function zoomAt(point: { x: number; y: number }, nextZoom: number): void {
  const clamped = Math.min(3, Math.max(0.2, nextZoom));
  const worldX = (point.x - pan.x) / zoom.value;
  const worldY = (point.y - pan.y) / zoom.value;
  zoom.value = clamped;
  pan.x = point.x - worldX * clamped;
  pan.y = point.y - worldY * clamped;
}

function onWheel(event: WheelEvent): void {
  if (contextMenu.value) closeContextMenu();
  const point = viewportPoint(event.clientX, event.clientY);
  const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
  zoomAt(point, zoom.value * factor);
}

function zoomBy(factor: number): void {
  const canvas = canvasEl.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  zoomAt({ x: rect.width / 2, y: rect.height / 2 }, zoom.value * factor);
}

function fitView(): void {
  if (!current.value?.nodes.length) {
    pan.x = 0;
    pan.y = 0;
    zoom.value = 1;
    return;
  }
  const canvas = canvasEl.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const minX = Math.min(...current.value.nodes.map((node) => node.position.x));
  const minY = Math.min(...current.value.nodes.map((node) => node.position.y));
  const maxX = Math.max(...current.value.nodes.map((node) => node.position.x + (node.size?.width ?? 240)));
  const maxY = Math.max(...current.value.nodes.map((node) => node.position.y + nodeHeight(node)));
  const next = Math.min(1.4, Math.max(0.2, Math.min((rect.width - 80) / Math.max(1, maxX - minX), (rect.height - 80) / Math.max(1, maxY - minY))));
  zoom.value = next;
  pan.x = 40 - minX * next;
  pan.y = 40 - minY * next;
}

function resetView(): void {
  pan.x = 0;
  pan.y = 0;
  zoom.value = 1;
}

function canvasDoubleClick(event: MouseEvent): void {
  if (!canEdit.value || !current.value) return;
  const point = screenToWorld(event.clientX, event.clientY);
  addNodeAt({ x: point.x - 120, y: point.y - 60 });
}

function nodeTypeOf(node: GraphNode | undefined): NodeTypeInfo | undefined {
  return node ? nodeTypes.value.find((type) => type.type === node.type) : undefined;
}

interface PreviewEntry {
  key: string;
  value: string;
}

/** 节点卡内联预览：展示已配置的参数内容，免去反复点开检查器。 */
function nodePreview(node: GraphNode): PreviewEntry[] {
  const entries: PreviewEntry[] = [];
  for (const [key, raw] of Object.entries(node.params ?? {})) {
    const value = previewText(raw);
    if (!value) continue;
    entries.push({ key, value });
    if (entries.length >= 3) break;
  }
  return entries;
}

/** 空的可接收文件的输入节点显示拖放提示。 */
function nodeDropHint(node: GraphNode): string {
  if (nodePreview(node).length) return '';
  const type = nodeTypeOf(node);
  if (!type || (type.category !== 'source' && !node.type.startsWith('input.'))) return '';
  const props = type.paramsSchema?.properties ?? {};
  return 'path' in props || 'images' in props ? t('board.dropNodeHint') : '';
}

function previewText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value).replace(/\s+/g, ' ');
  } catch {
    return '';
  }
}

function nodeHeight(node: GraphNode): number {
  const type = nodeTypeOf(node);
  const rows = Math.max(type?.inputs?.length ?? 0, type?.outputs?.length ?? 0, 1);
  const previewLines = nodePreview(node).length + (nodeDropHint(node) ? 1 : 0);
  const previewHeight = previewLines ? previewLines * 15 + 9 : 0;
  const content =
    2 + NODE_HEAD_HEIGHT + NODE_PORT_PADDING * 2 + rows * NODE_PORT_ROW + previewHeight + NODE_FOOT_HEIGHT;
  return Math.max(node.size?.height ?? 0, content, NODE_MIN_HEIGHT);
}

function portY(node: GraphNode, port: string, direction: 'in' | 'out'): number {
  const type = nodeTypeOf(node);
  const ports = direction === 'in' ? type?.inputs ?? [] : type?.outputs ?? [];
  const index = Math.max(0, ports.findIndex((item) => item.name === port));
  return node.position.y + 1 + NODE_HEAD_HEIGHT + NODE_PORT_PADDING + NODE_PORT_ROW / 2 + index * NODE_PORT_ROW;
}

function portX(node: GraphNode, direction: 'in' | 'out'): number {
  const width = node.size?.width ?? 240;
  return direction === 'in' ? node.position.x + PORT_DOT_INSET : node.position.x + width - PORT_DOT_INSET;
}

function bezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const bend = Math.max(60, Math.abs(x2 - x1) * 0.4);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function edgePath(edge: GraphEdge): string {
  const from = current.value?.nodes.find((node) => node.id === edge.from.node);
  const to = current.value?.nodes.find((node) => node.id === edge.to.node);
  if (!from || !to) return '';
  const x1 = portX(from, 'out');
  const y1 = portY(from, edge.from.port, 'out');
  const x2 = portX(to, 'in');
  const y2 = portY(to, edge.to.port, 'in');
  return bezierPath(x1, y1, x2, y2);
}

function portType(node: GraphNode, port: string, direction: 'in' | 'out'): string {
  const type = nodeTypeOf(node);
  const list = direction === 'in' ? type?.inputs ?? [] : type?.outputs ?? [];
  return list.find((item) => item.name === port)?.type ?? 'any';
}

function connectSourceType(): string {
  return connectDrag.active ? connectDrag.type : pendingFrom.value?.type ?? '';
}

function connectSourceDirection(): 'in' | 'out' {
  return connectDrag.active ? connectDrag.direction : 'out';
}

function portIsConnectTarget(port: PortInfo, direction: 'in' | 'out'): boolean {
  const type = connectSourceType();
  if (!type) return false;
  if (direction === connectSourceDirection()) return false;
  return compatible(type, port.type);
}

function hoverIs(nodeId: string, port: string, direction: 'in' | 'out'): boolean {
  return (
    connectDrag.hover?.nodeId === nodeId &&
    connectDrag.hover.port === port &&
    connectDrag.hover.direction === direction
  );
}

function startConnect(event: PointerEvent, node: GraphNode, port: PortInfo, direction: 'in' | 'out'): void {
  if (!canEdit.value) return;
  event.preventDefault();
  event.stopPropagation();
  blurActiveEdit();
  // 兼容“先点输出、再点输入”的连线方式。
  if (direction === 'in' && pendingFrom.value) {
    const source = pendingFrom.value;
    if (source.node === node.id) return;
    if (!compatible(source.type, port.type)) {
      setToast('warn', `${t('board.portType')}: ${source.type} → ${port.type}`);
      return;
    }
    if (connectPorts(source.node, source.port, node.id, port.name)) pendingFrom.value = null;
    return;
  }
  const point = screenToWorld(event.clientX, event.clientY);
  connectDrag.active = true;
  connectDrag.nodeId = node.id;
  connectDrag.port = port.name;
  connectDrag.type = port.type;
  connectDrag.direction = direction;
  connectDrag.startClientX = event.clientX;
  connectDrag.startClientY = event.clientY;
  connectDrag.pointerX = point.x;
  connectDrag.pointerY = point.y;
  connectDrag.moved = false;
  connectDrag.hover = null;
  pendingFrom.value = direction === 'out' ? { node: node.id, port: port.name, type: port.type } : null;
  window.addEventListener('pointermove', connectMove);
  window.addEventListener('pointerup', connectEnd);
}

function cancelConnect(): void {
  window.removeEventListener('pointermove', connectMove);
  window.removeEventListener('pointerup', connectEnd);
  connectDrag.active = false;
  connectDrag.hover = null;
  pendingFrom.value = null;
}

function connectMove(event: PointerEvent): void {
  if (!connectDrag.active) return;
  const point = screenToWorld(event.clientX, event.clientY);
  connectDrag.pointerX = point.x;
  connectDrag.pointerY = point.y;
  if (!connectDrag.moved) {
    const dx = Math.abs(event.clientX - connectDrag.startClientX);
    const dy = Math.abs(event.clientY - connectDrag.startClientY);
    if (dx > 3 || dy > 3) connectDrag.moved = true;
  }
  const hit = portFromEvent(event);
  connectDrag.hover =
    hit && hit.direction !== connectDrag.direction
      ? { ...hit, compatible: compatible(connectDrag.type, hit.type) }
      : null;
}

function connectEnd(event: PointerEvent): void {
  if (!connectDrag.active) return;
  window.removeEventListener('pointermove', connectMove);
  window.removeEventListener('pointerup', connectEnd);
  const drag = { ...connectDrag };
  connectDrag.active = false;
  connectDrag.hover = null;
  const hit = portFromEvent(event);
  if (hit && hit.direction !== drag.direction) {
    if (drag.direction === 'out') connectPorts(drag.nodeId, drag.port, hit.nodeId, hit.port);
    else connectPorts(hit.nodeId, hit.port, drag.nodeId, drag.port);
    pendingFrom.value = null;
    return;
  }
  // 没有拖动（只是单击输出端口）时保留 pending，继续支持点击连线。
  if (drag.direction === 'out' && !drag.moved) return;
  pendingFrom.value = null;
}

function portFromEvent(event: Event): PortHit | null {
  for (const item of event.composedPath()) {
    if (!(item instanceof HTMLElement)) continue;
    if (!item.classList.contains('port-row')) continue;
    const nodeId = item.dataset.nodeId ?? '';
    const port = item.dataset.port ?? '';
    if (!nodeId || !port) return null;
    return {
      nodeId,
      port,
      direction: item.dataset.direction === 'in' ? 'in' : 'out',
      type: item.dataset.portType ?? 'any',
    };
  }
  return null;
}

function connectPorts(fromNode: string, fromPort: string, toNode: string, toPort: string): boolean {
  if (!current.value || fromNode === toNode) return false;
  const fromType = portTypeOfNode(fromNode, fromPort, 'out');
  const toType = portTypeOfNode(toNode, toPort, 'in');
  if (!compatible(fromType, toType)) {
    setToast('warn', `${t('board.portType')}: ${fromType} → ${toType}`);
    return false;
  }
  const targetNode = current.value.nodes.find((node) => node.id === toNode);
  const targetDef = nodeTypeOf(targetNode)?.inputs?.find((port) => port.name === toPort);
  const sameTarget = current.value.edges.filter(
    (edge) => edge.to.node === toNode && edge.to.port === toPort,
  );
  if (sameTarget.length && !targetDef?.multiple) {
    current.value.edges = current.value.edges.filter(
      (edge) => !(edge.to.node === toNode && edge.to.port === toPort),
    );
  }
  if (
    current.value.edges.some(
      (edge) =>
        edge.from.node === fromNode &&
        edge.from.port === fromPort &&
        edge.to.node === toNode &&
        edge.to.port === toPort,
    )
  ) {
    return true;
  }
  current.value.edges.push({
    id: `edge-${Date.now().toString(36)}`,
    from: { node: fromNode, port: fromPort },
    to: { node: toNode, port: toPort },
  });
  dirty.value = true;
  setToast('success', t('board.edgeCreated'));
  return true;
}

function portTypeOfNode(nodeId: string, port: string, direction: 'in' | 'out'): string {
  const node = current.value?.nodes.find((item) => item.id === nodeId);
  return node ? portType(node, port, direction) : 'any';
}

function compatible(from: string, to: string): boolean {
  return from === 'any' || to === 'any' || from === to;
}

function openContextMenu(event: MouseEvent): void {
  if (composedTarget(event)?.closest('.board-node')) return;
  if (!canEdit.value) {
    if (current.value) setToast('warn', t('board.readonly'));
    return;
  }
  event.preventDefault();
  pendingFrom.value = null;
  const point = screenToWorld(event.clientX, event.clientY);
  const width = 252;
  const height = 340;
  contextMenu.value = {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    worldX: point.x,
    worldY: point.y,
  };
  contextFilter.value = '';
  window.addEventListener('pointerdown', contextOutside);
  void nextTick(() => contextSearchEl.value?.focus());
}

function closeContextMenu(): void {
  window.removeEventListener('pointerdown', contextOutside);
  contextMenu.value = null;
  contextFilter.value = '';
}

function contextOutside(event: PointerEvent): void {
  if (composedTarget(event)?.closest('.board-context-menu')) return;
  closeContextMenu();
}

function createFromContext(type: NodeTypeInfo): void {
  const menu = contextMenu.value;
  closeContextMenu();
  if (!menu) return;
  addNodeAt({ x: menu.worldX, y: menu.worldY }, type);
}

function inputSource(nodeId: string, port: string): string {
  const edge = current.value?.edges.find((item) => item.to.node === nodeId && item.to.port === port);
  if (!edge) return '';
  const source = current.value?.nodes.find((item) => item.id === edge.from.node);
  return source ? `${source.title} · ${edge.from.port}` : edge.from.node;
}

function nodeStateClass(node: GraphNode): string {
  const nodeState = state.graphRun.nodes[node.id]?.state;
  return nodeState ? `node-${nodeState}` : '';
}

function plainGraph(): GraphDocument {
  return JSON.parse(JSON.stringify(current.value)) as GraphDocument;
}

async function runGraph(): Promise<void> {
  if (!current.value || runStatus.value === 'running') return;
  error.value = '';
  try {
    const result = await request<{ status: string; nodes?: Record<string, { state: string; error?: string; cached?: boolean }> }>(
      'graph-run',
      { graph: plainGraph(), options: { concurrency: 3 } },
    );
    state.graphRun.status = result.status as typeof state.graphRun.status;
    if (result.nodes) state.graphRun.nodes = result.nodes;
    setToast(
      result.status === 'success' ? 'success' : result.status === 'cancelled' ? 'warn' : 'error',
      result.status === 'success'
        ? t('board.runSuccess')
        : result.status === 'cancelled'
          ? t('board.runCancelled')
          : t('board.runError'),
    );
  } catch (caught) {
    error.value = errorText(caught);
    state.graphRun.status = 'error';
  }
}

function nodeArtifacts(nodeId: string): Array<{ path?: string; name?: string; type?: string }> {
  return (state.graphRun.artifacts[nodeId] ?? []) as Array<{ path?: string; name?: string; type?: string }>;
}

async function previewArtifact(artifact: { path?: string; name?: string }): Promise<void> {
  if (!artifact.path) return;
  artifactLoading.value = true;
  try {
    artifactPreview.value = await request<{ name: string; mime: string; encoding: string; content: string }>(
      'graph-artifact-read',
      { path: artifact.path },
    );
  } catch (caught) {
    setToast('error', errorText(caught));
  } finally {
    artifactLoading.value = false;
  }
}

async function openRunDir(): Promise<void> {
  const graphId = current.value?.id;
  const runId = state.graphRun.runId;
  if (!graphId || !runId) return;
  try {
    await request('graph-run-open-dir', { graphId, runId });
  } catch (caught) {
    setToast('error', errorText(caught));
  }
}

async function cancelRun(): Promise<void> {
  const runId = state.graphRun.runId;
  if (!runId) return;
  try {
    await request('graph-run-cancel', { runId });
  } catch {
    // ignore
  }
}

function isTextarea(key: string): boolean {
  return selectedType.value?.uiSchema?.[key]?.control === 'textarea';
}

/** 能在检查器里直接选择文件的参数：输入节点的 path，或字符串数组（图片列表）。 */
function isFileParam(key: string, schema: ParamSchema): boolean {
  const node = selected.value;
  const isSource = Boolean(node && (node.type.startsWith('input.') || nodeTypeOf(node)?.category === 'source'));
  if (key === 'path') return isSource;
  return isSource && schema.type === 'array' && schema.items?.type === 'string';
}

function isArrayParam(key: string): boolean {
  const schema = selectedType.value?.paramsSchema?.properties?.[key];
  return schema?.type === 'array' || Array.isArray(selectedParams.value[key]);
}

async function pickFilesForParam(key: string): Promise<void> {
  const node = selected.value;
  if (!canEdit.value || !node) return;
  const array = isArrayParam(key);
  try {
    const result = await Editor.Dialog.select({
      title: array ? t('board.pickImages') : t('board.pickFile'),
      type: 'file',
      multi: array,
      filters: array
        ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tga', 'psd'] }]
        : [{
            name: 'Files',
            extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'wav', 'txt', 'md', 'json'],
          }],
    });
    const paths = (result.filePaths ?? []).filter(Boolean);
    if (result.canceled || !paths.length) return;
    if (array) {
      const current = Array.isArray(selectedParams.value[key])
        ? (selectedParams.value[key] as unknown[]).filter((item): item is string => typeof item === 'string')
        : [];
      setParam(key, uniquePaths([...current, ...paths]));
    } else {
      const props = selectedType.value?.paramsSchema?.properties ?? {};
      const params = { ...(node.params ?? {}) };
      const previousPath = typeof params.path === 'string' ? params.path : '';
      const previousName = typeof params.name === 'string' ? params.name : '';
      setParam(key, paths[0]);
      if ('name' in props && (!previousName || previousName === fileNameOf(previousPath))) {
        setParam('name', fileNameOf(paths[0]));
      }
    }
    node.disabled = false;
    setToast('success', t('board.dropped', { count: paths.length }));
  } catch (caught) {
    setToast('error', errorText(caught));
  }
}

function paramKind(key: string): string {
  const schema = selectedType.value?.paramsSchema?.properties?.[key];
  if (schema?.enum?.length) return 'enum';
  if (schema?.type === 'number') return 'number';
  if (schema?.type === 'boolean') return 'boolean';
  if (schema?.type === 'object' || schema?.type === 'array') return 'json';
  return 'string';
}

function setParam(key: string, value: unknown): void {
  if (!selected.value) return;
  selected.value.params = { ...(selected.value.params ?? {}), [key]: value };
  dirty.value = true;
}

interface ParamOption {
  value: string;
  label: string;
}

function uniqueParamOptions(options: ParamOption[]): ParamOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (!option.value || seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
}

/** 模型相关参数改用插件配置里的模型列表做下拉。 */
function modelSelectOptions(key: string): ParamOption[] {
  const profiles = modelProfiles.value;
  if (!profiles.length) return [];
  switch (key) {
    case 'modelProfileId':
      return uniqueParamOptions(
        profiles.map((profile) => ({ value: profile.id, label: `${profile.name}（${profile.modelId}）` })),
      );
    case 'visionProfileId':
      return uniqueParamOptions(
        profiles
          .filter((profile) => profile.vision)
          .map((profile) => ({ value: profile.id, label: `${profile.name}（${profile.modelId}）` })),
      );
    case 'provider':
      return uniqueParamOptions(
        profiles.map((profile) => ({ value: profile.providerId, label: profile.name })),
      );
    case 'model':
      return uniqueParamOptions(
        profiles.map((profile) => ({ value: profile.modelId, label: `${profile.modelId}（${profile.name}）` })),
      );
    default:
      return [];
  }
}

function clearParams(keys: string[]): void {
  if (!selected.value) return;
  const params = { ...(selected.value.params ?? {}) };
  let changed = false;
  for (const key of keys) {
    if (params[key] !== undefined) {
      delete params[key];
      changed = true;
    }
  }
  if (changed) {
    selected.value.params = params;
    dirty.value = true;
  }
}

/** provider/model/profile 三者互斥，避免节点上同时存在互相覆盖的配置。 */
function onModelParamChange(key: string, value: string): void {
  if (!selected.value) return;
  if (key === 'modelProfileId' || key === 'visionProfileId') {
    if (!value) {
      clearParams([key]);
      return;
    }
    setParam(key, value);
    clearParams(['provider', 'model']);
    return;
  }
  if (key === 'provider') {
    if (!value) {
      clearParams(['provider', 'model']);
      return;
    }
    const profile = modelProfiles.value.find((item) => item.providerId === value);
    setParam('provider', value);
    if (profile) setParam('model', profile.modelId);
    clearParams(['modelProfileId', 'visionProfileId']);
    return;
  }
  if (key === 'model') {
    if (!value) {
      clearParams(['model']);
      return;
    }
    const profile = modelProfiles.value.find((item) => item.modelId === value);
    setParam('model', value);
    if (profile) setParam('provider', profile.providerId);
    clearParams(['modelProfileId', 'visionProfileId']);
    return;
  }
  setParam(key, value);
}

function setJsonParam(key: string, event: Event): void {
  const value = (event.target as HTMLTextAreaElement).value;
  try {
    setParam(key, value.trim() ? JSON.parse(value) : undefined);
  } catch {
    setToast('warn', 'JSON 格式错误');
  }
}

function jsonParam(key: string): string {
  const value = selectedParams.value[key];
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function slug(value: string): string {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 48);
  return result || 'workflow';
}

function errorText(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  if (typeof caught === 'string') return caught;
  return String(caught);
}

function formatTime(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(timestamp));
  } catch {
    return '';
  }
}
</script>

<template>
  <div
    class="shell board-shell"
    @keydown="onBoardKeyDown"
    @dragover="onRootDragOver"
    @drop="onRootDrop"
    @dragleave="onRootDragLeave"
  >
    <header v-if="!embedded" class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">◆</span>
        <span class="brand-title">{{ t('brand.title') }}</span>
        <span class="phase-pill">Phase 4</span>
      </div>
      <div class="topbar-actions">
        <ViewTabs active="board" />
        <button type="button" class="icon-btn" :title="t('board.refresh')" @click="refreshGraphs">↻</button>
      </div>
    </header>

    <ApprovalBar />

    <main class="board-main">
      <aside class="board-side">
        <section class="side-section">
          <div class="side-head">
            <h2>{{ t('board.workflows') }}</h2>
            <button type="button" class="link-btn" @click="refreshGraphs">{{ t('board.refresh') }}</button>
          </div>
          <div v-if="!graphs.length" class="empty-line">{{ t('board.noWorkflows') }}</div>
          <div
            v-for="graph in graphs"
            :key="graph.id"
            class="graph-row"
            :class="{ active: current?.id === graph.id, invalid: graph.invalid }"
            :title="graph.invalid || graph.description"
            role="button"
            tabindex="0"
            @click="openGraph(graph)"
            @keydown.enter="openGraph(graph)"
          >
            <span class="graph-kind">{{ graph.builtin ? t('board.builtin') : t('board.user') }}</span>
            <span class="graph-name">{{ graph.name }}</span>
            <button
              v-if="!graph.builtin"
              type="button"
              class="graph-delete"
              :title="t('board.deleteWorkflow')"
              @click.stop="deleteGraph(graph)"
            >
              ×
            </button>
            <span v-else class="graph-count">{{ graph.nodeCount }}</span>
          </div>
          <div v-if="current" class="graph-meta">
            {{ current.id }} · {{ t('board.nodeCount', { count: current.nodes.length }) }}
            <span v-if="dirty" class="dirty-dot">●</span>
          </div>
        </section>

        <section class="side-section">
          <h2>{{ t('board.new') }}</h2>
          <div class="inline-form">
            <input v-model="newName" :placeholder="t('board.newPlaceholder')" @keydown.enter="createGraph" />
            <button type="button" class="btn" @click="createGraph">{{ t('board.create') }}</button>
          </div>
        </section>

        <section class="side-section">
          <h2>{{ t('board.addNode') }}</h2>
          <select v-model="addType" class="field-select">
            <option v-for="type in nodeTypes" :key="type.type" :value="type.type">{{ type.label }} · {{ type.type }}</option>
          </select>
          <button type="button" class="btn primary wide" :disabled="!canEdit" @click="addNode">＋ {{ t('board.addNode') }}</button>
          <p v-if="builtin" class="readonly-line">{{ t('board.readonly') }}</p>
        </section>
      </aside>

      <section class="board-stage">
        <div class="board-toolbar">
          <div class="board-title">
            <strong>{{ current?.name ?? t('board.empty') }}</strong>
            <span v-if="current && builtin" class="tag">{{ t('board.builtin') }}</span>
            <span v-if="dirty && current" class="tag dirty">*</span>
          </div>
          <div class="board-actions">
            <div class="zoom-controls">
              <button type="button" class="icon-btn" title="缩小" @click="zoomBy(1 / 1.15)">−</button>
              <span class="zoom-label">{{ Math.round(zoom * 100) }}%</span>
              <button type="button" class="icon-btn" title="放大" @click="zoomBy(1.15)">＋</button>
              <button type="button" class="btn ghost" title="适配视图" @click="fitView">适配</button>
              <button type="button" class="btn ghost" title="重置视图" @click="resetView">1:1</button>
            </div>
            <button type="button" class="btn" :disabled="!current || builtin" @click="saveGraph">{{ t('board.save') }}</button>
            <button v-if="builtin" type="button" class="btn" @click="duplicateGraph">{{ t('board.copy') }}</button>
            <button v-else type="button" class="btn ghost" @click="duplicateGraph">{{ t('board.duplicate') }}</button>
            <button
              type="button"
              class="btn primary"
              :disabled="!current || runStatus === 'running'"
              @click="runGraph"
            >
              {{ runStatus === 'running' ? t('board.running') : t('board.run') }}
            </button>
            <button v-if="runStatus === 'running'" type="button" class="btn danger" @click="cancelRun">
              {{ t('composer.stop') }}
            </button>
          </div>
        </div>

        <div v-if="error" class="error-line board-error">{{ error }}</div>
        <div v-if="pendingFrom" class="connect-hint">{{ t('board.connectHint') }}</div>

        <div
          ref="canvasEl"
          class="board-canvas"
          :class="{
            panning: panState.active && panState.moved,
            connecting: connectDrag.active,
            'file-drop': canvasDropActive,
          }"
          :style="canvasBgStyle"
          @pointerdown="canvasPointerDown"
          @wheel.prevent="onWheel"
          @dblclick="canvasDoubleClick"
          @contextmenu.prevent="openContextMenu"
          @dragover="dragOverCanvas"
          @dragleave="dragLeaveCanvas"
          @drop="dropOnCanvas"
        >
          <div v-if="canvasDropActive" class="canvas-drop-hint">{{ t('board.dropCanvasHint') }}</div>
          <div class="canvas-inner" :style="canvasInnerStyle">
            <svg class="edge-layer" width="2400" height="1400" aria-hidden="true">
              <path v-for="edge in current?.edges ?? []" :key="edge.id" :d="edgePath(edge)" class="board-edge" />
              <path
                v-if="tempEdgePath"
                :d="tempEdgePath"
                class="board-edge temp"
                :class="{ bad: connectDrag.hover && !connectDrag.hover.compatible }"
              />
            </svg>

            <article
              v-for="node in current?.nodes ?? []"
              :key="node.id"
              class="board-node"
              :class="[
                { selected: selectedId === node.id, disabled: node.disabled, 'drop-target': dropNodeId === node.id },
                nodeStateClass(node),
              ]"
              :style="{
                left: `${node.position.x}px`,
                top: `${node.position.y}px`,
                width: `${node.size?.width ?? 240}px`,
                height: `${nodeHeight(node)}px`,
              }"
              @pointerdown.stop="selectNode(node)"
              @dragover="dragOverNode($event, node)"
              @dragleave="dragLeaveNode"
              @drop="dropOnNode($event, node)"
            >
              <header class="node-head" @pointerdown.stop="dragStart($event, node)">
                <span class="node-category">{{ nodeTypeOf(node)?.category ?? 'node' }}</span>
                <strong class="node-title">{{ node.title }}</strong>
                <span v-if="state.graphRun.nodes[node.id]?.state" class="node-state-dot" :class="`state-${state.graphRun.nodes[node.id]?.state}`"></span>
              </header>
              <div class="node-ports">
                <div class="port-column inputs">
                  <button
                    v-for="port in nodeTypeOf(node)?.inputs ?? []"
                    :key="port.name"
                    type="button"
                    class="port-row input"
                    :class="{
                      'connect-target': portIsConnectTarget(port, 'in'),
                      'hover-target': hoverIs(node.id, port.name, 'in'),
                    }"
                    :title="`${port.name}: ${port.type}`"
                    :data-node-id="node.id"
                    :data-port="port.name"
                    data-direction="in"
                    :data-port-type="port.type"
                    @pointerdown.stop="startConnect($event, node, port, 'in')"
                  >
                    <span class="port-dot" :class="`port-${port.type.replace(/[^a-z0-9]/gi, '')}`"></span>
                    <span class="port-name">{{ port.name }}</span>
                  </button>
                </div>
                <div class="port-column outputs">
                  <button
                    v-for="port in nodeTypeOf(node)?.outputs ?? []"
                    :key="port.name"
                    type="button"
                    class="port-row output"
                    :class="{
                      pending: pendingFrom?.node === node.id && pendingFrom?.port === port.name,
                      'connect-target': portIsConnectTarget(port, 'out'),
                      'hover-target': hoverIs(node.id, port.name, 'out'),
                    }"
                    :title="`${port.name}: ${port.type}`"
                    :data-node-id="node.id"
                    :data-port="port.name"
                    data-direction="out"
                    :data-port-type="port.type"
                    @pointerdown.stop="startConnect($event, node, port, 'out')"
                  >
                    <span class="port-name">{{ port.name }}</span>
                    <span class="port-dot" :class="`port-${port.type.replace(/[^a-z0-9]/gi, '')}`"></span>
                  </button>
                </div>
              </div>
              <div v-if="nodePreview(node).length || nodeDropHint(node)" class="node-preview">
                <div v-for="entry in nodePreview(node)" :key="entry.key" class="node-preview-row">
                  <span class="node-preview-key">{{ entry.key }}</span>
                  <span class="node-preview-value">{{ entry.value }}</span>
                </div>
                <div v-if="nodeDropHint(node)" class="node-preview-row drop-hint">{{ nodeDropHint(node) }}</div>
              </div>
              <footer class="node-foot">
                <span>{{ node.type }}</span>
                <span v-if="state.graphRun.nodes[node.id]?.cached">cache</span>
              </footer>
            </article>
          </div>
        </div>

        <div
          v-if="contextMenu"
          class="board-context-menu"
          :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
          @pointerdown.stop
          @contextmenu.prevent
        >
          <div class="context-menu-head">
            <span>{{ t('board.newNodeMenu') }}</span>
            <button type="button" class="link-btn" @click="closeContextMenu">×</button>
          </div>
          <input
            ref="contextSearchEl"
            v-model="contextFilter"
            class="context-search"
            type="text"
            :placeholder="t('board.nodeSearch')"
            @keydown.esc.stop.prevent="closeContextMenu"
          />
          <div class="context-menu-list">
            <div v-if="!filteredNodeTypes.length" class="empty-line context-empty">{{ t('board.noNodeMatch') }}</div>
            <div v-for="group in filteredNodeTypes" :key="group.category" class="context-group">
              <div class="context-group-label">{{ categoryLabel(group.category) }}</div>
              <button
                v-for="type in group.types"
                :key="type.type"
                type="button"
                class="context-item"
                :title="type.description"
                @click="createFromContext(type)"
              >
                <span class="context-item-label">{{ type.label }}</span>
                <span class="context-item-type">{{ type.type }}</span>
              </button>
            </div>
          </div>
        </div>

        <section class="run-log">
          <div class="side-head">
            <h3>{{ t('board.logs') }}</h3>
            <div class="run-log-actions">
              <button
                type="button"
                class="link-btn"
                :disabled="!state.graphRun.runId"
                @click="openRunDir"
              >
                {{ t('board.openRunDir') }}
              </button>
              <button type="button" class="link-btn" @click="state.graphRun.logs = []">{{ t('board.clearLogs') }}</button>
            </div>
          </div>
          <div v-if="!state.graphRun.logs.length" class="empty-line">—</div>
          <div v-for="(log, index) in state.graphRun.logs" :key="`${log.at}-${index}`" class="log-row" :class="`log-${log.level}`">
            <span class="log-node">{{ log.nodeId }}</span>
            <span class="log-message">{{ log.message }}</span>
            <span class="log-time">{{ formatTime(log.at) }}</span>
          </div>
        </section>
      </section>

      <aside class="board-inspector">
        <div class="side-head">
          <h3>{{ t('board.inspector') }}</h3>
          <span v-if="selected" class="tag">{{ selected.type }}</span>
        </div>
        <div v-if="!selected" class="empty-line">{{ t('board.noSelection') }}</div>
        <template v-else>
          <label class="field">
            <span>{{ t('board.nodeTitle') }}</span>
            <input v-model="selected.title" :disabled="!canEdit" @input="dirty = true" />
          </label>
          <label class="check-row">
            <input v-model="selected.disabled" type="checkbox" :disabled="!canEdit" @change="dirty = true" />
            <span>{{ t('board.disabled') }}</span>
          </label>

          <h4 class="inspector-subtitle">{{ t('board.inputs') }}</h4>
          <div v-if="!selectedInputs.length" class="empty-line">—</div>
          <div v-for="port in selectedInputs" :key="port.name" class="port-info-row">
            <span class="port-info-name">
              <span class="port-dot" :class="`port-${port.type.replace(/[^a-z0-9]/gi, '')}`"></span>
              {{ port.name }}
            </span>
            <span class="port-info-type">{{ port.type }}</span>
            <span class="port-info-source" :class="{ unconnected: !inputSource(selected.id, port.name) }">
              {{ inputSource(selected.id, port.name) || t('board.unconnected') }}
            </span>
          </div>

          <h4 class="inspector-subtitle">{{ t('board.params') }}</h4>
          <div v-if="!paramEntries.length" class="empty-line">—</div>
          <label
            v-for="entry in paramEntries"
            :key="entry.key"
            class="field"
            :class="{ 'drop-target': dropParamKey === entry.key }"
            @dragover="dragOverParam(entry.key, $event)"
            @dragleave="dragLeaveParam(entry.key, $event)"
            @drop="dropOnParam($event, entry.key)"
          >
            <span>{{ entry.key }}</span>
            <select
              v-if="modelSelectOptions(entry.key).length"
              :value="String(selectedParams[entry.key] ?? '')"
              :disabled="!canEdit"
              @change="onModelParamChange(entry.key, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">{{ t('board.useDefault') }}</option>
              <option v-for="option in modelSelectOptions(entry.key)" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
            <select
              v-else-if="paramKind(entry.key) === 'enum'"
              :value="selectedParams[entry.key]"
              :disabled="!canEdit"
              @change="setParam(entry.key, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="option in entry.schema.enum ?? []" :key="String(option)" :value="option">{{ option }}</option>
            </select>
            <input
              v-else-if="paramKind(entry.key) === 'boolean'"
              type="checkbox"
              :checked="Boolean(selectedParams[entry.key])"
              :disabled="!canEdit"
              @change="setParam(entry.key, ($event.target as HTMLInputElement).checked)"
            />
            <textarea
              v-else-if="paramKind(entry.key) === 'json' || isTextarea(entry.key)"
              :value="paramKind(entry.key) === 'json' ? jsonParam(entry.key) : String(selectedParams[entry.key] ?? '')"
              :rows="selectedType?.uiSchema?.[entry.key]?.rows ?? 4"
              :disabled="!canEdit"
              @change="paramKind(entry.key) === 'json' ? setJsonParam(entry.key, $event) : setParam(entry.key, ($event.target as HTMLTextAreaElement).value)"
            ></textarea>
            <input
              v-else
              :type="paramKind(entry.key) === 'number' ? 'number' : 'text'"
              :value="selectedParams[entry.key] ?? ''"
              :disabled="!canEdit"
              @input="setParam(entry.key, paramKind(entry.key) === 'number' ? Number(($event.target as HTMLInputElement).value) : ($event.target as HTMLInputElement).value)"
            />
            <button
              v-if="isFileParam(entry.key, entry.schema)"
              type="button"
              class="link-btn pick-file-btn"
              :disabled="!canEdit"
              @click.prevent.stop="pickFilesForParam(entry.key)"
            >
              {{ isArrayParam(entry.key) ? t('board.pickImages') : t('board.pickFile') }}
            </button>
            <small v-if="entry.schema.description" class="field-hint">{{ entry.schema.description }}</small>
          </label>

          <button type="button" class="btn danger wide" :disabled="!canEdit" @click="deleteSelected">
            {{ t('board.deleteNode') }}
          </button>

          <div v-if="nodeArtifacts(selected.id).length" class="artifact-block">
            <h4 class="inspector-subtitle">输出产物</h4>
            <button
              v-for="artifact in nodeArtifacts(selected.id)"
              :key="artifact.path ?? artifact.name"
              type="button"
              class="artifact-row"
              :disabled="artifactLoading"
              @click="previewArtifact(artifact)"
            >
              <span>{{ artifact.name ?? artifact.path }}</span>
              <span class="muted">{{ artifact.type }}</span>
            </button>
          </div>

          <div v-if="artifactPreview" class="artifact-preview">
            <div class="side-head">
              <strong>{{ artifactPreview.name }}</strong>
              <button type="button" class="link-btn" @click="artifactPreview = null">×</button>
            </div>
            <img
              v-if="artifactPreview.mime.startsWith('image/')"
              :src="`data:${artifactPreview.mime};base64,${artifactPreview.content}`"
              :alt="artifactPreview.name"
            />
            <pre v-else-if="artifactPreview.encoding === 'utf8'">{{ artifactPreview.content }}</pre>
            <p v-else class="muted">二进制产物（{{ artifactPreview.mime }}）</p>
          </div>
        </template>
      </aside>
    </main>
  </div>
</template>
