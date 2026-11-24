import { mentionParts } from './mentions';

function rawNode(node: Node): string {
  if (node instanceof HTMLElement && node.dataset.mention) return node.dataset.mention;
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  // Chromium leaves a filler <br> after deleting the last character.
  if (node instanceof HTMLBRElement) return node.nextSibling ? '\n' : '';
  return Array.from(node.childNodes, rawNode).join('');
}

export function editorText(editor: HTMLElement): string {
  return rawNode(editor);
}

function selectionOf(editor: HTMLElement): Selection | null {
  const root = editor.getRootNode() as Document | (ShadowRoot & { getSelection?: () => Selection | null });
  return root.getSelection?.() ?? editor.ownerDocument.getSelection();
}

export function editorSelection(editor: HTMLElement): { start: number; end: number } {
  const selection = selectionOf(editor);
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || !editor.contains(range.commonAncestorContainer)) {
    const end = editorText(editor).length;
    return { start: end, end };
  }
  const prefix = editor.ownerDocument.createRange();
  prefix.selectNodeContents(editor);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = rawNode(prefix.cloneContents()).length;
  return { start, end: range.collapsed ? start : start + rawNode(range.cloneContents()).length };
}

/** A chip is one editable unit, but caret offsets address the full serialized message. */
export function renderEditor(editor: HTMLElement, text: string, caret?: number): void {
  const doc = editor.ownerDocument;
  const fragment = doc.createDocumentFragment();
  const cursor = doc.createRange();
  let offset = 0;
  for (const part of mentionParts(text)) {
    let child: Node;
    if (part.kind === 'text') child = doc.createTextNode(part.raw);
    else {
      const chip = doc.createElement('span');
      chip.contentEditable = 'false';
      chip.className = `mention-chip mention-chip-${part.kind}`;
      chip.dataset.mention = part.raw;
      chip.title = part.path;
      chip.textContent = part.name;
      child = chip;
    }
    fragment.append(child);
    offset += part.raw.length;
  }
  editor.replaceChildren(fragment);
  if (caret === undefined) return;
  editor.focus();
  cursor.selectNodeContents(editor);
  cursor.collapse(false);
  let remaining = Math.min(caret, offset);
  for (const child of Array.from(editor.childNodes)) {
    const length = rawNode(child).length;
    if (remaining <= length) {
      if (child.nodeType === Node.TEXT_NODE) cursor.setStart(child, remaining);
      else if (remaining === 0) cursor.setStartBefore(child);
      else cursor.setStartAfter(child);
      break;
    }
    remaining -= length;
  }
  cursor.collapse(true);
  const selection = selectionOf(editor);
  selection?.removeAllRanges();
  selection?.addRange(cursor);
}
