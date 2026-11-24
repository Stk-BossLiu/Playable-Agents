import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from '../utils/fs';

interface McpConfigFile {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpServerConfig {
  url: string;
  timeout: number;
  description: string;
}

const DESCRIPTION =
  'Cocos AI Agent official editor bridge. Use mcp__cocos__* for scene, node, component, property and asset operations; do not use the cocos-mcp development extension.';

/**
 * 合并写入 ~/.pi/agent/mcp.json。只增/改 mcpServers.<serverName>，保留用户其它 MCP 配置。
 * 首次写入前备份；卸载时移除我们的条目，文件因此变空则恢复备份或删除。
 */
let pendingWrite = Promise.resolve();
function serializeConfig<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingWrite.then(operation);
  pendingWrite = result.then(() => undefined, () => undefined);
  return result;
}

export async function readMcpConfig(path: string): Promise<McpConfigFile> {
  let text: string;
  try { text = await fsp.readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const config: unknown = JSON.parse(text);
  if (!isRecord(config) || (config.mcpServers !== undefined && !isRecord(config.mcpServers))) {
    throw new Error(`MCP 配置格式无效：${path}`);
  }
  return config;
}

export class McpConfigWriter {
  readonly configPath: string;
  readonly backupPath: string;

  constructor(
    private readonly serverName = 'cocos',
    homePath = homedir(),
  ) {
    const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homePath, '.pi', 'agent');
    this.configPath = join(agentDir, 'mcp.json');
    this.backupPath = `${this.configPath}.cocos-ai-agent.bak`;
  }

  write(url: string): Promise<string> {
    const server: McpServerConfig = { url, timeout: 600, description: DESCRIPTION };
    return serializeConfig(() => this.merge(server, false));
  }

  addStdio(server: { command: string; args: string[] }): Promise<string> {
    return serializeConfig(() => this.merge(server, true));
  }

  private async merge(server: McpServerConfig | { command: string; args: string[] }, onlyIfMissing: boolean): Promise<string> {
    await fsp.mkdir(dirname(this.configPath), { recursive: true });
    await this.ensureBackup();

    const existing = await readMcpConfig(this.configPath);
    const mcpServers = isRecord(existing.mcpServers) ? { ...existing.mcpServers } : {};
    if (onlyIfMissing && Object.hasOwn(mcpServers, this.serverName)) {
      throw new Error(`已有 mcpServers.${this.serverName} 配置，请检查 ${this.configPath}`);
    }
    mcpServers[this.serverName] = server;

    await writeJsonAtomic(this.configPath, { ...existing, mcpServers });
    return this.configPath;
  }

  remove(): Promise<void> {
    return serializeConfig(() => this.removeEntry());
  }

  private async removeEntry(): Promise<void> {
    const existing = await readMcpConfig(this.configPath);
    const mcpServers = isRecord(existing.mcpServers) ? { ...existing.mcpServers } : {};
    if (!(this.serverName in mcpServers)) return;
    delete mcpServers[this.serverName];

    const remainingTopLevel = Object.keys(existing).filter((key) => key !== 'mcpServers');
    const hasBackup = await fileExists(this.backupPath);

    if (Object.keys(mcpServers).length === 0) {
      if (hasBackup) {
        await fsp.copyFile(this.backupPath, this.configPath);
        await fsp.rm(this.backupPath, { force: true });
        return;
      }
      if (remainingTopLevel.length === 0) {
        await fsp.rm(this.configPath, { force: true });
        return;
      }
      delete existing.mcpServers;
      await writeJsonAtomic(this.configPath, existing);
      return;
    }

    await writeJsonAtomic(this.configPath, { ...existing, mcpServers });
  }

  private async ensureBackup(): Promise<void> {
    if (await fileExists(this.backupPath)) return;
    if (!(await fileExists(this.configPath))) return;
    await fsp.copyFile(this.configPath, this.backupPath);
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
