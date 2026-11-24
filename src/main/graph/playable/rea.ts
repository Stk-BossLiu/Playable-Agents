import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callRea } from './stdio';
// REA requires a finite, positive signed 32-bit per-source budget.
const MAX_SUPPORTED_INTERVAL = 0x7fffffff;

interface ServerConfig { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; disabled?: boolean }

/** Only the extracted scripts directory is exposed to the local, user-configured REA process. */
export async function inspectScripts(dir: string, sources: string[], signal: AbortSignal) {
  const configPath = join(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent'), 'mcp.json');
  let config: ServerConfig | undefined;
  try { config = JSON.parse(await readFile(configPath, 'utf8')).mcpServers?.rea; }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法解析 Pi MCP 配置'); }
  if (!config?.command || config.disabled) throw new Error('缺少启用的本地 stdio REA 配置（mcpServers.rea），请前往 Agent 状态面板安装 REA');
  signal.throwIfAborted();
  if (!sources.length) throw new Error('没有可分析的静态 JavaScript 文件');
  const result = await callRea({ command: config.command, args: config.args, cwd: config.cwd, env: config.env, stderr: 'ignore' }, {
    input_path: dir, format: 'directory', source_paths: sources, detail: 'summary', analysis_timeout_ms: MAX_SUPPORTED_INTERVAL,
  }, signal);
  const text = result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n');
  if (result.isError || !text.trim()) throw new Error(`REA 未返回分析摘要 ${text.slice(0, 320)}`);
  return { sources, summary: text.slice(0, 32000), truncated: text.length > 32000 };
}
