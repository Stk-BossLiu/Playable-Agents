import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readJson, writeJsonAtomic } from '../utils/fs';

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

  async write(url: string): Promise<string> {
    await fsp.mkdir(dirname(this.configPath), { recursive: true });
    await this.ensureBackup();

    const existing = (await readJson<McpConfigFile>(this.configPath)) ?? {};
    const mcpServers = isRecord(existing.mcpServers) ? { ...existing.mcpServers } : {};
    const server: McpServerConfig = { url, timeout: 600, description: DESCRIPTION };
    mcpServers[this.serverName] = server;

    await writeJsonAtomic(this.configPath, { ...existing, mcpServers });
    return this.configPath;
  }

  async remove(): Promise<void> {
    const existing = await readJson<McpConfigFile>(this.configPath);
    if (!existing) return;
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
