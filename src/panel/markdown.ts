import MarkdownIt from 'markdown-it';
import { mentionParts } from './mentions';

/** 面板内统一的 Markdown 渲染：禁用原始 HTML，链接新窗口打开。 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// GFM 任务列表：把「- [ ] / - [x]」渲染成复选框字符。
md.core.ruler.after('inline', 'task-list-checkbox', (state) => {
  const tokens = state.tokens;
  for (let index = 2; index < tokens.length; index += 1) {
    const inline = tokens[index];
    if (inline.type !== 'inline' || !inline.children?.length) continue;
    if (tokens[index - 1]?.type !== 'paragraph_open' || tokens[index - 2]?.type !== 'list_item_open') continue;
    const match = /^\[( |x|X)\]\s+/.exec(inline.content);
    if (!match) continue;
    const first = inline.children[0];
    if (first.type !== 'text') continue;
    first.content = `${match[1].toLowerCase() === 'x' ? '☑' : '☐'} ${first.content.replace(/^\[( |x|X)\]\s+/, '')}`;
  }
});

// Match editor references during inline parsing so fenced and inline code stay literal.
md.inline.ruler.before('text', 'editor_mention', (state, silent) => {
  if (!state.env?.chat || !state.src.startsWith('@【', state.pos)) return false;
  const end = state.src.indexOf('】', state.pos + 2);
  if (end < 0 || end >= state.posMax) return false;
  const raw = state.src.slice(state.pos, end + 1);
  const [part] = mentionParts(raw);
  if (!part || part.kind === 'text' || part.raw !== raw) return false;
  if (!silent) {
    const token = state.push('editor_mention', 'span', 0);
    token.attrSet('class', `mention-chip mention-chip-${part.kind}`);
    token.attrSet('title', part.path);
    token.content = part.name;
  }
  state.pos = end + 1;
  return true;
});

md.renderer.rules.editor_mention = (tokens, index, _options, _env, renderer) => {
  const token = tokens[index];
  return `<span${renderer.renderAttrs(token)}>${md.utils.escapeHtml(token.content)}</span>`;
};

// A generated reply should not initiate network or local file reads for images.
const renderImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, index, options, env, renderer) => env?.chat
  ? md.utils.escapeHtml(tokens[index].content)
  : renderImage(tokens, index, options, env, renderer);

export function renderMarkdown(text: string, context?: { chat: true }): string {
  return text.trim() ? md.render(text, context) : '';
}
