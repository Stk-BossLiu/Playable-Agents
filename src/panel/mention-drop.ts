import { nodeMentions, type Mention } from './mentions';

interface DragInfo { type?: string; value?: unknown; additional?: unknown }
function editorDragInfo(): DragInfo | undefined {
  return (Editor.UI as { DragArea?: { currentDragInfo?: DragInfo } } | undefined)?.DragArea?.currentDragInfo;
}
export function isMentionDrag(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  return Boolean(editorDragInfo()?.value) || Array.from(transfer.types).some(type => /node|asset|uuid|^value$|^additional$|^type$/i.test(type));
}
function collect(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) { value.forEach(item => collect(item, ids)); return; }
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    collect(item.uuid ?? item.value ?? item.url, ids);
  } else if (typeof value === 'string' && value.trim()) {
    const text = value.trim();
    if (/^[[{"]/.test(text)) {
      try { collect(JSON.parse(text), ids); } catch { /* malformed drag data */ }
    } else { ids.add(text); }
  }
}
export async function droppedMentions(transfer: DataTransfer): Promise<Mention[]> {
  // Read all native drag data synchronously before the first IPC await.
  const ids = new Set<string>();
  const info = editorDragInfo();
  collect(info?.value, ids);
  collect(info?.additional, ids);
  for (const type of transfer.types) {
    if (/node|asset|uuid|^value$|^additional$|^text\/plain$/i.test(type)) collect(transfer.getData(type), ids);
  }
  if (!ids.size) return [];
  const kind = `${info?.type ?? ''} ${transfer.getData('type')} ${Array.from(transfer.types).join(' ')}`;
  const nodes = /asset/i.test(kind) && !/node/i.test(kind) ? [] : nodeMentions(await Editor.Message.request('scene', 'query-node-tree').catch(() => null));
  const byId = new Map(nodes.map(node => [node.uuid, node]));
  const rows = new Map<string, Mention>();
  for (const id of ids) {
    let item = byId.get(id);
    if (!item) {
      const asset = await Editor.Message.request('asset-db', 'query-asset-info', id, ['uuid', 'url', 'isDirectory']).catch(() => null);
      if (asset?.uuid && asset.url && !asset.isDirectory) item = { kind: 'asset', uuid: asset.uuid, path: asset.url };
    }
    if (item) rows.set(`${item.kind}:${item.uuid}`, item);
  }
  return [...rows.values()];
}

