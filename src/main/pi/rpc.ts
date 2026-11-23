import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { ThinkingLevel } from '../../shared/types';

export interface RpcResponseRecord {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface RpcEventRecord {
  type: string;
  [key: string]: unknown;
}

export interface RpcImage {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface RpcSessionState {
  model?: {
    id?: string;
    name?: string;
    provider?: string;
    [key: string]: unknown;
  };
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  steeringMode?: string;
  followUpMode?: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  pendingMessageCount?: number;
  [key: string]: unknown;
}

export class RpcCommandError extends Error {
  code = 'RPC_COMMAND_FAILED';
  command: string;
  detail: string;

  constructor(command: string, detail: string) {
    super(`Pi RPC command failed (${command}): ${detail}`);
    this.name = 'RpcCommandError';
    this.command = command;
    this.detail = detail;
  }
}

export class RpcTimeoutError extends Error {
  code = 'RPC_TIMEOUT';
  command: string;

  constructor(command: string, timeoutMs: number) {
    super(`Pi RPC command timed out after ${timeoutMs}ms: ${command}`);
    this.name = 'RpcTimeoutError';
    this.command = command;
  }
}

interface PendingRequest {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Pi RPC 客户端：严格 JSONL 分帧（只按 LF 切分，兼容 CRLF），按 id 关联响应。
 * 禁止使用 readline：它会把 U+2028/U+2029 当作换行。
 */
export class PiRpcClient extends EventEmitter {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private seq = 0;
  private disposed = false;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly stdin: Writable,
    private readonly stdout: Readable,
  ) {
    super();
    this.stdout.on('data', this.onData);
    this.stdout.on('error', (error) => this.emit('stream-error', error));
    this.stdin.on('error', (error) => this.emit('stream-error', error));
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  request<T = unknown>(command: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('PiRpcClient has been disposed'));
    }

    const id = String(++this.seq);
    const commandName = String(command.type ?? 'unknown');
    const payload = { id, ...command };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new RpcTimeoutError(commandName, timeoutMs));
      }, timeoutMs);

      this.pending.set(id, {
        command: commandName,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.writeLine(JSON.stringify(payload)).catch((error: unknown) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  getState(): Promise<RpcSessionState> {
    return this.request<RpcSessionState>({ type: 'get_state' }, 30_000);
  }

  getMessages(): Promise<{ messages: unknown[] }> {
    return this.request<{ messages: unknown[] }>({ type: 'get_messages' }, 30_000);
  }

  prompt(
    message: string,
    options: { images?: RpcImage[]; streamingBehavior?: 'steer' | 'followUp' } = {},
  ): Promise<{ disposition: 'started' | 'queued' | 'handled' }> {
    return this.request<{ disposition: 'started' | 'queued' | 'handled' }>(
      {
        type: 'prompt',
        message,
        ...(options.images?.length ? { images: options.images } : {}),
        ...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
      },
      120_000,
    );
  }

  steer(message: string, images?: RpcImage[]): Promise<{ disposition: 'started' | 'queued' | 'handled' }> {
    return this.request({ type: 'steer', message, ...(images?.length ? { images } : {}) }, 120_000);
  }

  followUp(message: string, images?: RpcImage[]): Promise<{ disposition: 'started' | 'queued' | 'handled' }> {
    return this.request({ type: 'follow_up', message, ...(images?.length ? { images } : {}) }, 120_000);
  }

  abort(): Promise<unknown> {
    return this.request({ type: 'abort' }, 120_000);
  }

  clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return this.request({ type: 'clear_queue' }, 30_000);
  }

  newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
    return this.request({ type: 'new_session', ...(parentSession ? { parentSession } : {}) }, 60_000);
  }

  switchSession(path: string): Promise<unknown> {
    return this.request({ type: 'switch_session', sessionPath: path }, 60_000);
  }

  setModel(provider: string, modelId: string): Promise<unknown> {
    return this.request({ type: 'set_model', provider, modelId }, 60_000);
  }

  getAvailableModels(): Promise<{ models: unknown[] }> {
    return this.request({ type: 'get_available_models' }, 60_000);
  }

  cycleModel(): Promise<unknown> {
    return this.request({ type: 'cycle_model' }, 60_000);
  }

  setThinkingLevel(level: ThinkingLevel): Promise<unknown> {
    return this.request({ type: 'set_thinking_level', level }, 30_000);
  }

  getAvailableThinkingLevels(): Promise<{ levels: ThinkingLevel[] }> {
    return this.request({ type: 'get_available_thinking_levels' }, 30_000);
  }

  compact(): Promise<unknown> {
    return this.request({ type: 'compact' }, 600_000);
  }

  exportHtml(input?: string, output?: string): Promise<{ path?: string; filePath?: string }> {
    return this.request({ type: 'export_html', ...(input ? { input } : {}), ...(output ? { output } : {}) }, 120_000);
  }

  getSessionStats(): Promise<unknown> {
    return this.request({ type: 'get_session_stats' }, 30_000);
  }

  getCommands(): Promise<{ commands: unknown[] }> {
    return this.request({ type: 'get_commands' }, 30_000);
  }

  setSessionName(name: string): Promise<unknown> {
    return this.request({ type: 'set_session_name', name }, 30_000);
  }

  setAutoCompaction(enabled: boolean): Promise<unknown> {
    return this.request({ type: 'set_auto_compaction', enabled }, 30_000);
  }

  bash(command: string): Promise<unknown> {
    return this.request({ type: 'bash', command }, 120_000);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stdout.off('data', this.onData);
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`PiRpcClient disposed while waiting for ${entry.command} (${id})`));
    }
    this.pending.clear();
    this.removeAllListeners();
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim()) this.handleLine(line);
      newlineIndex = this.buffer.indexOf('\n');
    }
  };

  private handleLine(line: string): void {
    let record: RpcResponseRecord | RpcEventRecord;
    try {
      record = JSON.parse(line) as RpcResponseRecord | RpcEventRecord;
    } catch (error) {
      this.emit('protocol-error', { line, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    if (record.type === 'response') {
      const response = record as RpcResponseRecord;
      const id = response.id;
      if (id && this.pending.has(id)) {
        const entry = this.pending.get(id)!;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (response.success) entry.resolve(response.data);
        else entry.reject(new RpcCommandError(response.command, response.error ?? 'Unknown RPC error'));
      } else {
        this.emit('protocol-error', {
          record,
          error: response.success ? 'response without pending id' : response.error ?? 'RPC error without pending id',
        });
      }
    }

    this.emit('event', record);
    if (record.type) this.emit(record.type, record);
  }

  private writeLine(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.stdin.writable) {
        reject(new Error('Pi stdin is not writable'));
        return;
      }
      this.stdin.write(`${line}\n`, 'utf8', (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}
