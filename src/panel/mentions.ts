export interface Mention {
  kind: 'asset' | 'node';
  path: string;
  uuid: string;
}

export interface MentionRange { start: number; end: number; query: string }

export function mentionRange(text: string, caret: number): MentionRange | null {
  const prefix = text.slice(0, caret);
  const start = prefix.lastIndexOf('@');
  if (start < 0 || /[\w.@]/.test(prefix.charAt(start - 1))) return null;
  const query = prefix.slice(start + 1);
  if (/[\s@【】]/u.test(query)) return null;
  return { start, end: caret, query };
}

export function insertMention(text: string, range: MentionRange, item: Mention) {
  const detail = item.kind === 'asset' ? item.path : `${item.path} | uuid=${item.uuid}`;
  const prefix = `${text.slice(0, range.start)}@【${detail}】 `;
  return { text: prefix + text.slice(range.end), caret: prefix.length };
}

type TreeNode = { name?: unknown; uuid?: unknown; children?: TreeNode[] };
function propertyText(field: unknown): string {
  const value = field && typeof field === 'object' && 'value' in field ? field.value : field;
  return typeof value === 'string' ? value : '';
}

export function nodeMentions(root: TreeNode | null): Mention[] {
  const rows: Mention[] = [];
  function visit(node: TreeNode, parent: string): void {
    const name = propertyText(node.name);
    const uuid = propertyText(node.uuid);
    const path = name ? `${parent}/${name}` : parent;
    if (uuid && name) rows.push({ kind: 'node', path, uuid });
    for (const child of node.children ?? []) visit(child, path);
  }
  if (root) visit(root, '');
  return rows;
}

// Keep both sources visible even in projects containing thousands of assets.
const PER_SOURCE = 20;
export function matchMentions(items: readonly Mention[], query: string): Mention[] {
  const needle = query.toLowerCase();
  const result: Mention[] = [];
  const counts = { asset: 0, node: 0 };
  for (const item of items) {
    if (counts[item.kind] >= PER_SOURCE || !item.path.toLowerCase().includes(needle)) continue;
    counts[item.kind]++;
    result.push(item);
    if (result.length === PER_SOURCE * 2) break;
  }
  return result;
}

export type MentionPart = { kind: 'text'; raw: string } | {
  kind: Mention['kind']; raw: string; path: string; name: string;
};

/** Interpret the existing message format without changing what gets sent or stored. */
export function mentionParts(text: string): MentionPart[] {
  const parts: MentionPart[] = [];
  let start = 0;
  for (const match of text.matchAll(/@【(db:\/\/[^】\r\n]+|\/[^】\r\n]+? \| uuid=[^】\r\n]+)】/gu)) {
    const detail = match[1];
    const kind = detail.startsWith('db://') ? 'asset' : 'node';
    const path = kind === 'asset' ? detail : detail.slice(0, detail.lastIndexOf(' | uuid='));
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!name) continue;
    const index = match.index!;
    if (index > start) parts.push({ kind: 'text', raw: text.slice(start, index) });
    parts.push({ kind, raw: match[0], path, name });
    start = index + match[0].length;
  }
  if (start < text.length) parts.push({ kind: 'text', raw: text.slice(start) });
  return parts;
}
