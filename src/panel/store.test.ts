import { describe, expect, it } from 'vitest';
import { applyAgentStatus, extractContent, extractThinking, handleAgentEvent, state } from './store';

describe('assistant content extraction', () => {
  it('keeps thinking out of the answer text', () => {
    const content = [
      { type: 'thinking', thinking: '先计算再回答' },
      { type: 'text', text: '121932631112635269' },
    ];
    expect(extractContent(content)).toBe('121932631112635269');
    expect(extractThinking(content)).toBe('先计算再回答');
  });

  it('handles text-only messages', () => {
    expect(extractContent([{ type: 'text', text: '正常' }])).toBe('正常');
    expect(extractThinking([{ type: 'text', text: '正常' }])).toBe('');
  });

  it('ignores tool calls in text', () => {
    expect(
      extractContent([
        { type: 'text', text: 'A' },
        { type: 'toolCall', id: 't1', name: 'read' },
        { type: 'text', text: 'B' },
      ]),
    ).toBe('AB');
  });
});

describe('conversation running state', () => {
  it('does not treat a running idle process as an active conversation', () => {
    state.running = false;
    applyAgentStatus({ running: true } as never);
    expect(state.running).toBe(false);
  });

  it('clears the stop state when the agent settles', () => {
    state.running = true;
    state.streaming = true;
    handleAgentEvent({ type: 'agent_settled' });
    expect(state.running).toBe(false);
    expect(state.streaming).toBe(false);
  });
});
