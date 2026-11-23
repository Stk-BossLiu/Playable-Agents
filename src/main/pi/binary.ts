import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  promises as fsp,
  readdirSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { PiBinaryInfo, PiDownloadProgress } from '../../shared/types';
import { ensureDir } from '../utils/fs';

const execFileAsync = promisify(execFile);

export const DEFAULT_PI_VERSION = '1.4.0';

const PLATFORM_ASSETS: Record<string, string> = {
  'win32-x64': 'pi-windows-x64.zip',
  'win32-arm64': 'pi-windows-arm64.zip',
  'darwin-x64': 'pi-darwin-x64.tar.gz',
  'darwin-arm64': 'pi-darwin-arm64.tar.gz',
  'linux-x64': 'pi-linux-x64.tar.gz',
  'linux-arm64': 'pi-linux-arm64.tar.gz',
};

export interface PiBinaryOptions {
  version: string;
  mirror: string;
  customPath: string;
}

type ProgressFn = (progress: PiDownloadProgress) => void;

export class PiBinaryManager {
  constructor(private readonly projectPath: string) {}

  getPlatformKey(): string {
    return `${process.platform}-${process.arch}`;
  }

  getAssetName(platform = this.getPlatformKey()): string {
    const asset = PLATFORM_ASSETS[platform];
    if (!asset) {
      throw new Error(`不支持的平台：${platform}（支持：${Object.keys(PLATFORM_ASSETS).join(', ')}）`);
    }
    return asset;
  }

  getInstallDir(version: string, platform = this.getPlatformKey()): string {
    return join(this.projectPath, '.dev', 'cocos-ai-agent', 'bin', normalizeVersion(version), platform);
  }

  getBinaryPath(version: string, platform = this.getPlatformKey()): string {
    return join(this.getInstallDir(version, platform), executableName());
  }

  /** 解析顺序：自定义路径 → 已下载 → PATH 中的 pi。 */
  async resolve(options: PiBinaryOptions): Promise<PiBinaryInfo | null> {
    const custom = options.customPath.trim();
    if (custom && isFile(custom)) {
      return {
        path: custom,
        source: 'custom',
        version: normalizeVersion(options.version) || DEFAULT_PI_VERSION,
        platform: this.getPlatformKey(),
        arch: process.arch,
      };
    }

    const version = normalizeVersion(options.version) || DEFAULT_PI_VERSION;
    const downloaded = this.getBinaryPath(version);
    if (isFile(downloaded)) {
      return {
        path: downloaded,
        source: 'downloaded',
        version,
        platform: this.getPlatformKey(),
        arch: process.arch,
      };
    }

    const pathPi = findPiOnPath();
    if (pathPi) {
      return {
        path: pathPi,
        source: 'path',
        version: 'unknown',
        platform: this.getPlatformKey(),
        arch: process.arch,
      };
    }

    return null;
  }

  async download(options: PiBinaryOptions, onProgress: ProgressFn = () => undefined): Promise<PiBinaryInfo> {
    const version = normalizeVersion(options.version) || DEFAULT_PI_VERSION;
    const platform = this.getPlatformKey();
    const asset = this.getAssetName(platform);
    const installDir = ensureDir(this.getInstallDir(version, platform));
    const binaryPath = this.getBinaryPath(version, platform);

    if (isFile(binaryPath)) {
      onProgress({ phase: 'done', percent: 100, received: 0, total: 0, message: '已存在，跳过下载' });
      return { path: binaryPath, source: 'downloaded', version, platform, arch: process.arch };
    }

    const baseUrl = `https://github.com/earendil-works/pi/releases/download/v${version}`;
    const archiveUrl = withMirror(options.mirror, `${baseUrl}/${asset}`);
    const sumsUrl = withMirror(options.mirror, `${baseUrl}/SHA256SUMS`);
    const archivePath = join(installDir, `${asset}.download`);

    onProgress({ phase: 'resolving', percent: 0, received: 0, total: 0, message: archiveUrl });
    await downloadFile(archiveUrl, archivePath, (progress) => {
      onProgress({ ...progress, phase: 'downloading' });
    });

    onProgress({ phase: 'verifying', percent: 0, received: 0, total: 0, message: '校验 SHA256' });
    const sums = await fetchText(sumsUrl);
    const expected = parseSums(sums, asset);
    if (!expected) {
      await fsp.rm(archivePath, { force: true });
      throw new Error(`SHA256SUMS 中找不到 ${asset}`);
    }
    const actual = await sha256File(archivePath);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      await fsp.rm(archivePath, { force: true });
      throw new Error(`SHA256 校验失败：期望 ${expected}，实际 ${actual}`);
    }

    onProgress({ phase: 'extracting', percent: 0, received: 0, total: 0, message: '解压' });
    try {
      await extractArchive(archivePath, installDir);
    } catch (error) {
      await fsp.rm(archivePath, { force: true });
      throw new Error(
        `解压失败：${error instanceof Error ? error.message : String(error)}。` +
          'Windows 需要系统自带 tar（Win10 1803+）；也可手动放置 pi 二进制并在设置中选择路径。',
      );
    }
    await fsp.rm(archivePath, { force: true });

    const extracted = findFile(installDir, executableName());
    if (!extracted) {
      throw new Error(`解压后未找到 ${executableName()}，请手动放置二进制。`);
    }
    if (extracted !== binaryPath) {
      await fsp.rm(binaryPath, { force: true });
      await fsp.rename(extracted, binaryPath);
    }
    if (process.platform !== 'win32') {
      await fsp.chmod(binaryPath, 0o755);
    }

    await fsp.writeFile(
      join(installDir, 'pi.json'),
      `${JSON.stringify(
        {
          version,
          platform,
          asset,
          sha256: actual,
          binary: basename(binaryPath),
          downloadedAt: new Date().toISOString(),
          source: archiveUrl,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    onProgress({ phase: 'done', percent: 100, received: 0, total: 0, message: binaryPath });
    return { path: binaryPath, source: 'downloaded', version, platform, arch: process.arch };
  }
}

export async function readPiVersion(binaryPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binaryPath, ['--version'], { windowsHide: true, timeout: 15_000 });
    const match = String(stdout).match(/\d+\.\d+\.\d+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

function normalizeVersion(value: string): string {
  return String(value ?? '').trim().replace(/^v/i, '');
}

function executableName(): string {
  return process.platform === 'win32' ? 'pi.exe' : 'pi';
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function withMirror(mirror: string, url: string): string {
  const prefix = String(mirror ?? '').trim();
  if (!prefix) return url;
  return `${prefix.replace(/\/+$/, '')}/${url}`;
}

function findPiOnPath(): string | null {
  const command = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(command, ['pi'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (result.status !== 0 || !result.stdout) return null;
  const candidates = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => (process.platform === 'win32' ? /\.exe$/i.test(line) : true));
  return candidates.find(isFile) ?? null;
}

function downloadFile(url: string, dest: string, onProgress: (progress: PiDownloadProgress) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const go = (currentUrl: string, redirects: number): void => {
      if (redirects > 5) {
        reject(new Error(`重定向次数过多：${url}`));
        return;
      }
      const client = currentUrl.startsWith('https:') ? httpsGet : httpGet;
      const req = client(
        currentUrl,
        { headers: { 'user-agent': 'cocos-ai-agent/0.1.0' } },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = res.headers.location;
            res.resume();
            if (!location) {
              reject(new Error(`HTTP ${status} 缺少 Location：${currentUrl}`));
              return;
            }
            go(new URL(location, currentUrl).toString(), redirects + 1);
            return;
          }
          if (status >= 400) {
            res.resume();
            reject(new Error(`下载失败 HTTP ${status}：${currentUrl}`));
            return;
          }

          const total = Number(res.headers['content-length'] ?? 0);
          let received = 0;
          let lastReport = 0;
          const out = createWriteStream(dest);
          out.on('error', reject);
          out.on('finish', () => resolve());
          res.on('error', reject);
          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            out.write(chunk);
            const now = Date.now();
            if (now - lastReport > 200 || (total > 0 && received >= total)) {
              lastReport = now;
              onProgress({
                phase: 'downloading',
                percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0,
                received,
                total,
              });
            }
          });
          res.on('end', () => out.end());
        },
      );
      req.on('error', reject);
      req.setTimeout(120_000, () => req.destroy(new Error(`下载超时：${currentUrl}`)));
    };
    go(url, 0);
  });
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const go = (currentUrl: string, redirects: number): void => {
      if (redirects > 5) {
        reject(new Error(`重定向次数过多：${url}`));
        return;
      }
      const client = currentUrl.startsWith('https:') ? httpsGet : httpGet;
      const req = client(currentUrl, { headers: { 'user-agent': 'cocos-ai-agent/0.1.0' } }, (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = res.headers.location;
          res.resume();
          if (!location) {
            reject(new Error(`HTTP ${status} 缺少 Location：${currentUrl}`));
            return;
          }
          go(new URL(location, currentUrl).toString(), redirects + 1);
          return;
        }
        if (status >= 400) {
          res.resume();
          reject(new Error(`请求失败 HTTP ${status}：${currentUrl}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(30_000, () => req.destroy(new Error(`请求超时：${currentUrl}`)));
    };
    go(url, 0);
  });
}

function parseSums(text: string, asset: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && match[2].trim() === asset) return match[1];
  }
  return null;
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function extractArchive(archive: string, dest: string): Promise<void> {
  const isZip = archive.toLowerCase().endsWith('.zip');
  const args = isZip ? ['-xf', archive, '-C', dest] : ['-xzf', archive, '-C', dest];
  await execFileAsync('tar', args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
}

function findFile(root: string, name: string, depth = 3): string | null {
  if (depth < 0) return null;
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}
