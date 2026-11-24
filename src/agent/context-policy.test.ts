import { describe, expect, it, vi } from 'vitest';
import register from '../agent/cocos-tools';
import { matchChatCommands } from '../panel/chat-commands';

const setup = () => {
  const pi = { on: vi.fn(), registerCommand: vi.fn() };
  register(pi);
  const hook = (name: string) => pi.on.mock.calls.find(([key]) => key === name)![1];
  const ctx = { getContextUsage: vi.fn(), compact: vi.fn() };
  return { hook, ctx };
};

describe('chat context policy', () => {
  it('starts at exactly 90%, once per active attempt, including the first measured turn', () => {
    const { hook, ctx } = setup();
    for (const tokens of [null, 8999, 9000, 9400]) {
      ctx.getContextUsage.mockReturnValue({ tokens, contextWindow: 10000 });
      hook('turn_end')({}, ctx);
      expect(ctx.compact).toHaveBeenCalledTimes(tokens !== null && tokens >= 9000 ? 1 : 0);
    }
    ctx.compact.mock.calls[0][0].onError(new Error('test'));
    hook('turn_end')({}, ctx);
    expect(ctx.compact).toHaveBeenCalledTimes(2);
  });
  it('preserves manual and overflow compaction below threshold', () => {
    const { hook, ctx } = setup();
    ctx.getContextUsage.mockReturnValue({ tokens: 25, contextWindow: 1000 });
    const before = hook('session_before_compact');
    expect(before({ reason: 'threshold' }, ctx)).toEqual({ cancel: true });
    expect(before({ reason: 'manual' }, ctx)).toBeUndefined();
    expect(before({ reason: 'overflow' }, ctx)).toBeUndefined();
  });
  it('directs chat document writes to project docs', () => {
    const { hook } = setup();
    expect(hook('before_agent_start')({}).systemPrompt).toContain('docs/');
    const write = (path: string) => hook('tool_call')({ toolName: 'write', input: { path } });
    expect(write('analysis/report.md')?.block).toBe(true);
    expect(write('docs/analysis/report.md')).toBeUndefined();
    expect(write('assets/scripts/Game.ts')).toBeUndefined();
  });
  it('offers slash commands only at the beginning of the draft', () => {
    expect(matchChatCommands('/')).toEqual(['/compact', '/new']);
    expect(matchChatCommands('/co')).toEqual(['/compact']);
    expect(matchChatCommands('assets/ui')).toEqual([]);
  });
});
