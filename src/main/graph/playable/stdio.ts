import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, InitializeResultSchema, LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';

/** Single-tool stdio session. Wait for the response, transport exit, or user cancellation.
 * The high-level SDK Client arms a request timer even if timeout is omitted or zero. */
export async function callRea(server: StdioServerParameters, args: Record<string, unknown>, signal: AbortSignal) {
  const transport = new StdioClientTransport(server);
  let sequence = 0;
  let failure: Error | undefined;
  let pending: { id: number; resolve(value: unknown): void; reject(error: Error): void } | undefined;
  function fail(error: Error) { failure = error; pending?.reject(error); }
  function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    signal.throwIfAborted();
    if (failure) throw failure;
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending = { id, resolve, reject };
      transport.send({ jsonrpc: '2.0', id, method, params }).catch(fail);
    });
  }
  transport.onerror = fail;
  transport.onclose = () => fail(new Error('REA 进程已退出'));
  transport.onmessage = message => {
    if ('method' in message) {
      if ('id' in message) void transport.send(message.method === 'ping'
        ? { jsonrpc: '2.0', id: message.id, result: {} }
        : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } }).catch(fail);
      return;
    }
    if (!pending || message.id !== pending.id) return;
    if ('error' in message) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
    pending = undefined;
  };
  const cancel = () => fail(new Error('REA 分析已取消'));
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    await transport.start();
    const hello = InitializeResultSchema.parse(await request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'cocos-playable-analysis', version: '1.0.0' },
    }));
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(hello.protocolVersion)) throw new Error(`REA MCP 协议版本不受支持 ${hello.protocolVersion}`);
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return CallToolResultSchema.parse(await request('tools/call', { name: 'analyze_javascript_application', arguments: args }));
  } finally {
    signal.removeEventListener('abort', cancel);
    await transport.close();
  }
}
