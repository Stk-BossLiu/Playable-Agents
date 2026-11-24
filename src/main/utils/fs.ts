import { mkdirSync, promises as fsp } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function assertInside(root: string, target: string): string {
  if (!isInside(root, target)) {
    throw new Error(`Path escapes project root: ${target}`);
  }
  return resolve(target);
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Create project-owned directories without following linked path components. */
export async function ensureProjectDirectory(root: string, directory: string): Promise<void> {
  const destination = assertInside(root, directory);
  let current = resolve(root);
  for (const segment of relative(current, destination).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try { await fsp.mkdir(current); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
    const stat = await fsp.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`输出目录不可用 ${current}`);
  }
}
