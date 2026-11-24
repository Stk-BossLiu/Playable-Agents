import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders headings, lists and tables', () => {
    const html = renderMarkdown('# 标题\n\n- a\n- b\n\n| a | b |\n| - | - |\n| 1 | 2 |');
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<table>');
  });

  it('renders GFM task list checkboxes', () => {
    const html = renderMarkdown('- [ ] todo\n- [x] done');
    expect(html).toContain('☐ todo');
    expect(html).toContain('☑ done');
  });

  it('escapes raw html', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('opens links in a new window', () => {
    const html = renderMarkdown('[docs](https://docs.cocos.com/)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

it('renders chat mentions alongside Markdown while keeping example code literal', () => {
  const node = '@【/Canvas/确认 | uuid=123】';
  const asset = '@【db://assets/ui/icon_<x>.png】';
  const html = renderMarkdown(`**检查 ${node}** ${asset}\n\n\`${node}\`\n\n\`\`\`ts\n${asset}\n\`\`\``, { chat: true });
  expect(html).toContain('<strong>检查 <span class="mention-chip mention-chip-node" title="/Canvas/确认">确认</span></strong>');
  expect(html).toContain('class="mention-chip mention-chip-asset" title="db://assets/ui/icon_&lt;x&gt;.png">icon_&lt;x&gt;.png</span>');
  expect(html).toContain(`<code>${node}</code>`);
  expect(html).toContain('<code class="language-ts">@【db://assets/ui/icon_&lt;x&gt;.png】');
  expect(renderMarkdown('![alt](https://example.org/image)', { chat: true })).not.toContain('<img');
});
