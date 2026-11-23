import MarkdownIt from 'markdown-it';

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

export function renderMarkdown(text: string): string {
  return text.trim() ? md.render(text) : '';
}
