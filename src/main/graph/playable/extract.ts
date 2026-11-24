import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { ensureProjectDirectory, isInside } from '../../utils/fs';
import { digest, type inspectPlayable } from './html';

type Inventory = ReturnType<typeof inspectPlayable>;
const MAX_LOCAL_BYTES = 128 * 1024 * 1024;
const mimeExtensions: Record<string, string> = {
  'image/svg+xml': 'svg', 'image/jpeg': 'jpg', 'audio/mpeg': 'mp3', 'application/octet-stream': 'bin',
  'application/javascript': 'js', 'text/javascript': 'js', 'application/ecmascript': 'js', 'text/ecmascript': 'js',
};
const safeExtension = /^(?:png|avif|jpe?g|webp|gif|svg|atlas|skel|plist|mp3|ogg|wav|m4a|aac|mp4|webm|ktx2?|json|glb|gltf|wasm|woff2?|ttf|bin|css|m?js|cjs)$/i;

function decodeData(raw: string): Buffer {
  const split = raw.indexOf(',');
  if (split < 0) throw new Error('data URI 缺少数据段');
  const body = raw.slice(split + 1);
  if (/;base64$/i.test(raw.slice(0, split))) {
    const text = body.replace(/\s/g, '');
    if (!/^[\w+/\-]*={0,2}$/.test(text) || text.replace(/=+$/, '').length % 4 === 1) throw new Error('Base64 数据格式无效');
    return Buffer.from(text, 'base64');
  }
  // Decode percent escapes byte-for-byte, including binary data outside UTF-8.
  return Buffer.from(Buffer.from(body).toString('latin1').replace(/%([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
}
interface ExtractedCode { id: string; offset: number; path: string; bytes: number; sha256: string }
interface SavedReference { path?: string; bytes?: number; sha256?: string; reason?: string }

export async function extractPlayable(projectRoot: string, htmlPath: string, sha256: string, inventory: Inventory, signal: AbortSignal) {
  signal.throwIfAborted();
  const root = join(projectRoot, 'playable-analyse');
  await ensureProjectDirectory(projectRoot, root);
  const directory = await mkdtemp(join(root, `${sha256.slice(0, 12)}-`));
  const scriptsDir = join(directory, 'scripts');
  await Promise.all([mkdir(scriptsDir), mkdir(join(directory, 'assets'))]);
  const localRoot = await realpath(dirname(htmlPath));
  const code: ExtractedCode[] = [];
  const sources: string[] = [];
  const save = async (path: string, data: string | Buffer) => {
    await writeFile(join(directory, path), data, { signal, flag: 'wx' });
    return { path, bytes: Buffer.byteLength(data), sha256: digest(data) };
  };
  for (const script of inventory.scripts) {
    const name = `${script.id}.js`;
    code.push({ id: script.id, offset: script.offset, ...await save(`scripts/${name}`, script.source) });
    sources.push(name);
  }
  const dataBlocks = [];
  for (const [i, block] of inventory.blocks.entries()) {
    const id = `B${i + 1}`;
    const dir = block.ext === 'css' ? 'scripts' : 'assets';
    const file = await save(`${dir}/${id}.${block.ext}`, block.source);
    if (dir === 'scripts') code.push({ id, offset: block.offset, ...file });
    else dataBlocks.push({ id, offset: block.offset, name: `${id}.${block.ext}`, kind: block.ext, form: '内嵌数据块', ...file });
  }
  let localBytes = 0;
  const saved = new Map<string, SavedReference>();
  const assets: (Omit<Inventory['assets'][number], 'raw' | 'tag' | 'state'> & SavedReference)[] = [...dataBlocks];
  for (const { raw, tag, ...asset } of inventory.assets) {
    signal.throwIfAborted();
    const embedded = /^data:/i.test(raw);
    const mime = asset.kind.toLowerCase();
    const ext = embedded ? mimeExtensions[mime] || mime.split('/')[1]?.match(/^[a-z0-9]{1,10}$/)?.[0] || 'bin' : extname(raw.split(/[?#]/, 1)[0]).slice(1).toLowerCase();
    const js = ['js','mjs','cjs'].includes(ext) || (tag === 'script' && asset.state === 'HTML 声明');
    const key = `${js ? 'js' : 'ref'}:${raw}`;
    let result = saved.get(key);
    if (!result) {
      let data: Buffer | undefined;
      try {
        if (embedded) data = decodeData(raw);
        else {
          const name = decodeURIComponent(raw.split(/[?#]/, 1)[0]);
          if (/^[\/\\]|[:\\\0]/.test(name) || name.split('/').some(s => s.startsWith('.') && s !== '.')) throw new Error('外部或越界引用');
          if (!safeExtension.test(ext)) throw new Error('未识别的本地资源类型');
          const file = await realpath(resolve(localRoot, name));
          if (!isInside(localRoot, file)) throw new Error('引用超出 HTML 所在目录');
          const info = await stat(file);
          if (!info.isFile() || localBytes + info.size > MAX_LOCAL_BYTES) throw new Error('本地依赖超过提取预算或不是普通文件');
          data = await readFile(file, { signal });
          localBytes += data.length;
        }
      } catch (err) {
        signal.throwIfAborted();
        result = { reason: (err as NodeJS.ErrnoException).code || String((err as Error).message) };
      }
      if (data) {
        const name = `${asset.id}.${js && !['js','mjs','cjs'].includes(ext) ? 'js' : ext}`;
        result = await save(`${js || ext === 'css' ? 'scripts' : 'assets'}/${name}`, data);
        if (js) { sources.push(name); code.push({ id: asset.id, offset: asset.offset, path: result.path!, bytes: data.length, sha256: result.sha256! }); }
      }
      if (result) saved.set(key, result);
    }
    assets.push({ ...asset, ...result });
  }
  return { directory, scriptsDir, sources, code, assets };
}
