import { beforeEach, describe, expect, it } from 'vitest';
import { applyAgentStatus, extractContent, extractThinking, handleAgentEvent, hydrateMessages, resetMessages, state } from './store';

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

describe('inline assistant errors', () => {
  const errorMessage = '404: {"type":"model_not_found","message":"Unsupported model"}';
  const failed = { role: 'assistant', content: [], errorMessage, stopReason: 'error' };
  beforeEach(resetMessages);

  it('attaches a terminal error to the current turn even without a start event', () => {
    hydrateMessages([{ role: 'assistant', content: 'Earlier reply' }, { role: 'user', content: 'Retry' }]);
    handleAgentEvent({ type: 'message_end', message: failed });
    expect(state.messages).toHaveLength(3);
    expect(state.messages[0].error).toBeUndefined();
    expect(state.messages[2]).toMatchObject({ role: 'assistant', error: errorMessage, streaming: false });
  });

  it('keeps the stream error and partial answer in a single message', () => {
    handleAgentEvent({ type: 'message_start', message: { role: 'assistant', content: 'Partial reply' } });
    handleAgentEvent({ type: 'message_update', assistantMessageEvent: { type: 'error', error: failed } });
    handleAgentEvent({ type: 'message_end', message: { ...failed, errorMessage: undefined } });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ text: 'Partial reply', error: errorMessage, streaming: false });
  });

  it('restores the provider error when opening a saved conversation', () => {
    hydrateMessages([failed, { role: 'assistant', content: 'Recovered', stopReason: 'stop' }]);
    expect(state.messages[0].error).toBe(errorMessage);
    expect(state.messages[1].error).toBeUndefined();
  });
});
