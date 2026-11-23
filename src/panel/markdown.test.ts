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
