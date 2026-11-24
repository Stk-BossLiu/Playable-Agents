import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentProcessManager } from '../pi/process';
import { ToolRegistry } from '../bridge/schema';
import { PLAYABLE_AGENT_TYPE, PLAYABLE_SYSTEM_PROMPT } from '../../shared/playable';
import { AgentRuntime } from './agent';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture() {
  vi.stubGlobal('Editor', { Project: { path: '.' }, Message: { send: vi.fn() } });
  const runtime = new AgentRuntime(new ToolRegistry());
  const rpc = {
    setModel: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue({ disposition: 'started' }),
    getState: vi.fn().mockResolvedValue({}),
  };
  // The worker stands in for a separate Pi process. Chat receives no prompts or workflow events.
  const worker = runtime['nodeProcess'];
  vi.spyOn(worker, 'running', 'get').mockReturnValue(true);
  vi.spyOn(worker, 'client', 'get').mockReturnValue(rpc as unknown as AgentProcessManager['client']);
  const stop = vi.spyOn(worker, 'stop').mockResolvedValue();
  const start = (prompt: string) => runtime.runNodeAgent({ prompt }, new AbortController().signal, vi.fn());
  const event = (type: string, fields = {}) => worker.emit('rpc-event', { type, ...fields });
  const end = (text: string) => event('message_end', { message: { role: 'assistant', content: [{ type: 'text', text }] } });
  return { start, event, end, rpc, stop, runtime };
}

it('holds the node queue through tool turns and retries until Pi settles', async () => {
  const { start, event, end, rpc, stop } = fixture();
  const first = start('文案理解');
  const second = start('编写项目分析');
  await setImmediate();
  for (const intermediate of ['turn_end', 'agent_end']) {
    event(intermediate);
    await setImmediate();
    expect(stop).not.toHaveBeenCalled();
    expect(rpc.prompt).toHaveBeenCalledTimes(1);
  }
  end('文案');
  event('agent_settled');
  expect((await first).text).toBe('文案');
  await setImmediate();
  expect(rpc.prompt.mock.calls.map(([prompt]) => prompt)).toEqual(['文案理解', '编写项目分析']);
  end('分析');
  event('agent_settled');
  expect((await second).text).toBe('分析');
  expect(stop).toHaveBeenCalledTimes(2);
});

it('surfaces the last model failure even after earlier assistant text', async () => {
  const { start, event, end } = fixture();
  const result = start('项目分析');
  await setImmediate();
  end('上一次工具调用');
  event('message_end', { message: { role: 'assistant', stopReason: 'error', content: [], errorMessage: 'maximum context length exceeded' } });
  event('agent_settled');
  await expect(result).rejects.toThrow('maximum context length exceeded');
});


it('routes reverse sessions through the dedicated default and honors a paired node override', async () => {
  const { runtime, rpc, event, end } = fixture();
  vi.spyOn(runtime.models, 'getAgentProfileId').mockImplementation(kind => kind === PLAYABLE_AGENT_TYPE ? 'reverse' : null);
  vi.spyOn(runtime.models, 'resolveProfile').mockReturnValue({ provider: 'pi-reverse', modelId: 'reverse-default' });
  for (const [agentType, override] of [['analysis.rea-reverse', false], [PLAYABLE_AGENT_TYPE, true]] as const) {
    const run = runtime.runNodeAgent({ agentType, systemPrompt: PLAYABLE_SYSTEM_PROMPT, prompt: 'evidence',
      ...(override ? { provider: 'pi-override', model: 'node-model' } : {}) }, new AbortController().signal, vi.fn());
    await setImmediate();
    expect(rpc.setModel).toHaveBeenLastCalledWith(...(override ? ['pi-override', 'node-model'] : ['pi-reverse', 'reverse-default']));
    expect(rpc.prompt.mock.calls.at(-1)?.[0]).toBe('evidence');
    end('[]'); event('agent_settled'); await run;
  }
  const args = new AgentProcessManager()['buildArgs']({ piPath: 'pi', cwd: '.', name: 'reverse', sessionDir: '.',
    systemPrompt: PLAYABLE_SYSTEM_PROMPT, ephemeral: true, evidenceOnly: true });
  expect(args[args.indexOf('--system-prompt') + 1]).toBe(PLAYABLE_SYSTEM_PROMPT);
  expect(args).toEqual(expect.arrayContaining(['--no-tools', '--no-extensions', '--no-session']));
});
