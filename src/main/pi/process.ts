import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { PiRpcClient } from './rpc';
import { ensureDir } from '../utils/fs';

const MAX_STDERR_LINES = 500;

export interface AgentSpawnOptions {
  piPath: string;
  cwd: string;
  sessionDir: string;
  name: string;
  provider?: string;
  model?: string;
  thinking?: string;
  extensionPath?: string;
  tools?: string;
  noBuiltinTools?: boolean;
  env?: Record<string, string | undefined>;
  resume?: boolean;
  ephemeral?: boolean;
}

export interface AgentProcessSnapshot {
  running: boolean;
  pid?: number;
  startedAt?: number;
  uptimeMs?: number;
  stderrTail: string[];
}

export interface AgentExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
  stderrTail: string[];
}

export class AgentProcessManager extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rpcClient: PiRpcClient | null = null;
  private startedAt = 0;
  private stopping = false;
  private stderrLines: string[] = [];
  private stderrDecoder = new StringDecoder('utf8');
  private stderrBuffer = '';

  get client(): PiRpcClient | null {
    return this.rpcClient;
  }

  get running(): boolean {
    return this.proc !== null;
  }

  get stderrTail(): string[] {
    return [...this.stderrLines];
  }

  start(options: AgentSpawnOptions): AgentProcessSnapshot {
    if (this.proc) return this.status();

    ensureDir(options.sessionDir);
    const args = this.buildArgs(options);
    const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };

    const proc = spawn(options.piPath, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.proc = proc;
    this.startedAt = Date.now();
    this.stopping = false;
    this.stderrLines = [];
    this.stderrBuffer = '';
    this.stderrDecoder = new StringDecoder('utf8');

    const rpc = new PiRpcClient(proc.stdin, proc.stdout);
    this.rpcClient = rpc;
    rpc.on('event', (event) => this.emit('rpc-event', event));
    rpc.on('protocol-error', (error) => this.emit('protocol-error', error));
    rpc.on('stream-error', (error) => this.emit('stream-error', error));

    proc.stderr.on('data', (chunk: Buffer) => this.collectStderr(chunk));
    proc.on('error', (error) => {
      this.pushStderr(`[spawn-error] ${error.message}`);
      this.emit('spawn-error', error);
    });
    proc.on('exit', (code, signal) => this.handleExit(code, signal));

    return this.status();
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      this.disposeClient();
      return;
    }

    this.stopping = true;
    try {
      proc.stdin.end();
    } catch {
      // ignore
    }

    if (await this.waitForExit(2000)) return;

    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
    if (await this.waitForExit(2000)) return;

    if (process.platform === 'win32' && proc.pid) {
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      });
      await this.waitForExit(1500);
      return;
    }

    try {
      proc.kill('SIGKILL');
    } catch {
      // ignore
    }
    await this.waitForExit(1000);
  }

  status(): AgentProcessSnapshot {
    return {
      running: this.proc !== null,
      pid: this.proc?.pid,
      startedAt: this.startedAt || undefined,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : undefined,
      stderrTail: this.stderrTail,
    };
  }

  private buildArgs(options: AgentSpawnOptions): string[] {
    const args = [
      '--mode',
      'rpc',
      '--session-dir',
      options.sessionDir,
      '--name',
      options.name,
    ];

    if (options.provider) args.push('--provider', options.provider);
    if (options.model) args.push('--model', options.model);
    if (options.thinking && options.thinking !== 'default') args.push('--thinking', options.thinking);
    if (options.extensionPath && existsSync(options.extensionPath)) {
      args.push('--extension', options.extensionPath);
    }
    if (options.noBuiltinTools) args.push('--no-builtin-tools');
    if (options.tools) args.push('--tools', options.tools);
    if (options.ephemeral) args.push('--no-session');
    else if (options.resume) args.push('--continue');

    return args;
  }

  private collectStderr(chunk: Buffer): void {
    this.stderrBuffer += this.stderrDecoder.write(chunk);
    let index = this.stderrBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stderrBuffer.slice(0, index).replace(/\r$/, '');
      this.stderrBuffer = this.stderrBuffer.slice(index + 1);
      if (line) this.pushStderr(line);
      index = this.stderrBuffer.indexOf('\n');
    }
  }

  private pushStderr(line: string): void {
    this.stderrLines.push(line);
    if (this.stderrLines.length > MAX_STDERR_LINES) {
      this.stderrLines.splice(0, this.stderrLines.length - MAX_STDERR_LINES);
    }
    this.emit('stderr', line);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const expected = this.stopping;
    this.proc = null;
    this.startedAt = 0;
    this.disposeClient();

    const info: AgentExitInfo = {
      code,
      signal,
      expected,
      stderrTail: this.stderrTail,
    };
    this.stopping = false;
    this.emit('exit', info);
    if (!expected) this.emit('crash', info);
  }

  private disposeClient(): void {
    this.rpcClient?.dispose();
    this.rpcClient = null;
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.proc) return Promise.resolve(true);
    const proc = this.proc;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.off('exit', onExit);
        resolve(value);
      };
      const onExit = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      proc.once('exit', onExit);
    });
  }
}
