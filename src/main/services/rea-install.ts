import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { DependencyItem } from '../../shared/dependencies';
import { McpConfigWriter, readMcpConfig } from '../pi/mcp-config';

const run = promisify(execFile);
const version = '6.8.0';
const dependency = { id: 'rea', label: 'REA 逆向', required: false };
const toolName = 'analyze_javascript_application';

export async function checkRea(): Promise<DependencyItem> {
  const { configPath } = new McpConfigWriter('rea');
  try {
    const { mcpServers } = await readMcpConfig(configPath);
    if (!mcpServers || !Object.hasOwn(mcpServers, 'rea')) return { ...dependency, state: 'missing',
      message: '安装后可分析参考试玩的内联脚本。', path: configPath };
    const entry = mcpServers.rea;
    if (!entry || typeof entry !== 'object' || !('command' in entry) || typeof entry.command !== 'string'
      || !entry.command.trim() || ('disabled' in entry && entry.disabled)) {
      return { ...dependency, state: 'not-configured', path: configPath, message: '请检查已有 rea 配置的 command 和 disabled。' };
    }
    return { ...dependency, state: 'ready', path: configPath, message: '已配置本地 REA MCP。' };
  } catch {
    return { ...dependency, state: 'error', path: configPath, message: '无法读取 MCP 配置，请检查文件权限和 JSON 格式。' };
  }
}

async function npmCli(node: string): Promise<string> {
  const bin = dirname(node);
  const candidates = [join(bin, 'node_modules/npm/bin/npm-cli.js'), join(bin, '../lib/node_modules/npm/bin/npm-cli.js')];
  if (process.platform !== 'win32') {
    for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
      const path = await fs.realpath(join(dir, 'npm')).catch(() => '');
      if (path.endsWith('/npm-cli.js')) candidates.push(path);
    }
  }
  for (const path of candidates) if (await fs.stat(path).then(s => s.isFile(), () => false)) return path;
  throw new Error('未找到 npm CLI，请安装包含 npm 的 Node.js 并重启 Creator。');
}

async function verifyServer(command: string, args: string[]): Promise<void> {
  const client = new Client({ name: 'cocos-rea-installer', version: '1' });
  const options = { signal: AbortSignal.timeout(30_000), timeout: 20_000 };
  try {
    await client.connect(new StdioClientTransport({ command, args, stderr: 'ignore' }), options);
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor }, options);
      if (page.tools.some(tool => tool.name === toolName)) return;
      cursor = page.nextCursor;
    } while (cursor);
    throw new Error(`缺少 ${toolName}`);
  } finally { await client.close(); }
}

let installing: Promise<string> | undefined;
export function installRea(): Promise<string> {
  return installing ??= install().finally(() => { installing = undefined; });
}

async function install(): Promise<string> {
  const writer = new McpConfigWriter('rea');
  const existing = await checkRea();
  if (existing.state !== 'missing') throw new Error(`${existing.message} ${writer.configPath}`);
  const node = await run('node', ['-p', 'process.execPath'], { cwd: homedir(), windowsHide: true, timeout: 5000 })
    .then(r => r.stdout.trim(), () => { throw new Error('Creator 找不到 Node.js，请安装 Node.js 并重启 Creator。'); });
  const npm = await npmCli(node);
  const root = join(dirname(writer.configPath), 'tools', `rea-${version}`);
  await fs.mkdir(root, { recursive: true });
  try {
    await run(node, [npm, 'install', '--prefix', root, '--no-save', '--no-package-lock', '--ignore-scripts', '--no-audit',
      '--no-fund', '--engine-strict', `rea-agents@${version}`], { cwd: root, windowsHide: true, timeout: 300_000 });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const code = stderr.match(/(?:error|ERR!) code ([\w-]+)/i)?.[1];
    const hint = code === 'EBADENGINE' ? '请使用满足 ^22.23.4、^24.22.1 或 >=26.12.1 的 Node.js。' : '请检查 npm 仓库连接和目录写入权限后重试。';
    throw new Error(`REA 安装失败${code ? ` (${code})` : ''}。${hint}`);
  }
  const args = [join(root, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'), 'mcp'];
  await verifyServer(node, args);
  return writer.addStdio({ command: node, args });
}
