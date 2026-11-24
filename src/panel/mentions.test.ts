import { describe, expect, it } from 'vitest';
import { insertMention, matchMentions, mentionRange, nodeMentions, type Mention } from './mentions';

describe('composer references', () => {
  it('opens after Chinese text and replaces only the reference at the cursor', () => {
    const draft = '请检查@按钮 的颜色';
    const range = mentionRange(draft, draft.indexOf(' '));
    expect(range?.query).toBe('按钮');
    const [button] = nodeMentions({ name: 'Canvas', uuid: 'root', children: [{ name: { value: '按钮' }, uuid: { value: 'btn' } }] }).slice(1);
    const result = insertMention(draft, range!, button);
    expect(result.text.slice(0, result.caret)).toContain('@【/Canvas/按钮 | uuid=btn】');
    expect(result.text.slice(result.caret)).toBe(' 的颜色');
    expect(mentionRange(result.text, result.caret)).toBeNull();
    expect(mentionRange('dev@example', 11)).toBeNull();
  });

  it('keeps nodes discoverable alongside a large asset collection and searches full paths', () => {
    const assets: Mention[] = Array.from({ length: 60 }, (_, index) => ({ kind: 'asset', path: `db://assets/UI/icon${index}.png`, uuid: `id${index}` }));
    const node = nodeMentions({ name: 'UI', uuid: 'node' })[0];
    expect(matchMentions([...assets, node], 'ui')).toContain(node);
    expect(matchMentions(assets, 'ui/icon59')).toEqual([assets[59]]);
    expect(insertMention('@', { start: 0, end: 1, query: '' }, assets[59]).text).toContain(assets[59].path);
  });
});
