import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolRegistry } from './schema';
import { toMcpContent, type ToolResult } from './result';
import { writeJsonAtomic } from '../utils/fs';

export interface BridgeServerOptions {
  registry: ToolRegistry;
  projectPath: string;
  name?: string;
  version?: string;
  /** 由 ToolExecutor 注入门禁/审批；不传则直接调用 registry（测试/降级）。 */
  execute?: (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class BridgeServer {
  private httpServer: Server | null = null;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly name: string;
  private readonly version: string;
  private port = 0;
  private url = '';
  private starting: Promise<string> | null = null;

  constructor(private readonly options: BridgeServerOptions) {
    this.name = options.name ?? 'cocos';
    this.version = options.version ?? '0.1.0';
  }

  getUrl(): string {
    return this.url;
  }

  getPort(): number {
    return this.port;
  }

  isRunning(): boolean {
    return this.httpServer !== null;
  }

  getToolCount(): number {
    return this.options.registry.getSchemas().length;
  }

  async start(): Promise<string> {
    if (this.httpServer && this.url) return this.url;
    if (this.starting) return this.starting;

    this.starting = new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      server.once('error', (error) => {
        this.starting = null;
        reject(error);
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          this.starting = null;
          reject(new Error('BridgeServer failed to obtain a TCP address'));
          return;
        }
        this.httpServer = server;
        this.port = address.port;
        this.url = `http://127.0.0.1:${this.port}${MCP_PATH}`;
        this.starting = null;
        void this.writeState(true);
        console.log(`[cocos-ai-agent] bridge listening at ${this.url}`);
        resolve(this.url);
      });
    });

    return this.starting;
  }

  async stop(): Promise<void> {
    for (const [sessionId, entry] of [...this.sessions.entries()]) {
      this.sessions.delete(sessionId);
      try {
        await entry.transport.close();
      } catch {
        // ignore
      }
      try {
        await entry.server.close();
      } catch {
        // ignore
      }
    }

    const server = this.httpServer;
    this.httpServer = null;
    this.url = '';
    this.port = 0;
    await this.writeState(false);

    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private createMcpServer(): McpServer {
    const server = new McpServer(
      { name: this.name, version: this.version },
      { capabilities: { tools: { listChanged: true } } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.options.registry.getSchemas(),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const ctx = { bridgeUrl: this.url, toolCount: this.getToolCount() };
      const result = this.options.execute
        ? await this.options.execute(toolName, args, ctx)
        : await this.options.registry.call(toolName, args, ctx);
      // SDK 1.25 的 CallTool 返回类型包含实验性 task 字段；我们的 MCP content 形状是标准结果。
      return toMcpContent(result) as any;
    });

    return server;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];

    if (path === '/health') {
      sendJson(res, 200, {
        ok: true,
        name: this.name,
        url: this.url,
        toolCount: this.getToolCount(),
        sessions: this.sessions.size,
        pid: process.pid,
      });
      return;
    }

    if (path !== MCP_PATH) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    try {
      const method = req.method ?? 'GET';
      const body = method === 'POST' ? await readJsonBody(req) : undefined;
      const header = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(header) ? header[0] : header;
      const session = sessionId ? this.sessions.get(sessionId) : undefined;

      if (session) {
        await session.transport.handleRequest(req, res, body);
        return;
      }

      if (sessionId) {
        sendJson(res, 404, {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        });
        return;
      }

      if (method === 'POST' && isInitializeRequest(body)) {
        let server: McpServer | null = null;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (server) this.sessions.set(newSessionId, { server, transport });
          },
        });
        server = this.createMcpServer();
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) this.sessions.delete(id);
          if (server) {
            server.close().catch(() => undefined);
          }
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: Server not initialized' },
        id: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[cocos-ai-agent] bridge request failed', error);
      sendJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message },
        id: null,
      });
    }
  }

  private async writeState(active: boolean): Promise<void> {
    try {
      await writeJsonAtomic(join(this.options.projectPath, '.dev', 'cocos-ai-agent-server.json'), {
        projectPath: this.options.projectPath,
        name: this.name,
        url: this.url,
        port: this.port,
        active,
        editorPid: process.pid,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.warn('[cocos-ai-agent] write bridge state failed', error);
    }
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}
