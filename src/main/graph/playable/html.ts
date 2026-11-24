import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { parse, type DefaultTreeAdapterTypes as Html } from 'parse5';
import { isLocalPlayableHtml } from '../../../shared/playable';

const MAX_HTML_BYTES = 24 * 1024 * 1024;
const MAX_ASSETS = 2500;
const MAX_CLUES = 120;
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export async function readPlayable(path: unknown) {
  if (!isLocalPlayableHtml(path)) throw new Error('参考试玩仅支持本地 .html 文件的绝对路径');
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_HTML_BYTES) throw new Error('请选择 1 字节至 24 MiB 的 HTML 文件');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('读取时文件已变化，请重试');
      offset += read.bytesRead;
    }
    const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!/<(?:!doctype\s+html|html|head|body|canvas|script|div|img|style|button|svg)\b/i.test(html)) throw new Error('文件缺少可识别的 HTML 入口');
    return { html, bytes: bytes.length, sha256: digest(bytes) };
  } finally { await handle.close(); }
}

interface Asset { raw: string; tag: string; id: string; name: string; kind: string; form: string; offset: number; bytes?: number; state: 'HTML 声明' | '脚本字面量候选' }
interface Script { id: string; offset: number; source: string }
interface Clue { id: string; label: string; offset: number; script: string; excerpt: string }
const signals: ReadonlyArray<[string, RegExp]> = [
  ['引擎线索', /\b(?:cc\.game|cclegacy|CocosCreator|UnityLoader|createUnityInstance|PIXI\.Application|Phaser\.Game|Laya\.init|THREE\.Scene)\b/g],
  ['模块与事件', /\b(?:System\.register|System\.import|define|require|dispatchEvent|emit)\s*\(/g],
  ['玩家输入', /\b(?:touchstart|touchend|touchmove|pointerdown|pointerup|pointermove|click)\b/g],
  ['玩法阶段', /\b(?:gameStart|gameEnd|game_end|levelUp|wave|win|lose|retry|restart|tutorial|score)\b/gi],
  ['广告宿主或 CTA', /\b(?:mraid\.open|installGame|downloadGame|ExitApi\.exit|gameReady)\b/g],
];

export function inspectPlayable(html: string) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const assets: Asset[] = [], scripts: Script[] = [], clues: Clue[] = [];
  const limits = new Set<string>();
  const blocks: { offset: number; source: string; ext: string }[] = [];
  const addAsset = (raw: string, offset: number, state: Asset['state'], fallback: string) => {
    if (assets.length >= MAX_ASSETS) { limits.add('资源索引达到上限'); return; }
    const data = /^data:([\w.+/-]+)(?:;[^,]{0,150})?,/i.exec(raw);
    const name = data ? `${data[1]}（内嵌）` : raw.slice(0, 180).split(/[?#]/, 1)[0];
    if (!name) return;
    assets.push({ raw, tag: fallback, id: `A${assets.length + 1}`, name, kind: data?.[1] ?? name.match(/\.([\w]{1,8})$/)?.[1] ?? fallback,
      form: data ? '内嵌 data URI' : '外部引用', offset, state, ...(data ? { bytes: Buffer.byteLength(raw) } : {}) });
  };
  const addCssUrls = (source: string, offset: number) => {
    for (const match of source.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi)) {
      const raw = match[1] ?? match[2] ?? match[3];
      if (raw && !raw.startsWith('#')) addAsset(raw, offset + match.index!, 'HTML 声明', 'style');
      if (assets.length >= MAX_ASSETS) { limits.add('资源索引达到上限'); break; }
    }
  };
  const pending: Html.Node[] = [document];
  while (pending.length) {
    const node = pending.pop()!;
    if ('childNodes' in node) for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]);
    if (!('tagName' in node) || !node.sourceCodeLocation) continue;
    const loc = node.sourceCodeLocation;
    for (const attr of node.attrs) {
      if (attr.name === 'style') addCssUrls(attr.value, loc.attrs?.style?.startOffset ?? loc.startOffset);
      if (['src', 'poster'].includes(attr.name) || (node.tagName === 'link' && attr.name === 'href')) {
        addAsset(attr.value, loc.attrs?.[attr.name]?.startOffset ?? loc.startOffset, 'HTML 声明', node.tagName);
      }
    }
    if (node.tagName !== 'script' && node.tagName !== 'style') continue;
    const offset = loc.startTag?.endOffset ?? loc.startOffset;
    const source = html.slice(offset, loc.endTag?.startOffset ?? loc.endOffset);
    if (!source.trim()) continue;
    const isScript = node.tagName === 'script';
    const mime = node.attrs.find(a => a.name === 'type')?.value.trim().toLowerCase();
    const executable = isScript && (!mime || mime === 'module' || /^(text|application)\/(java|ecma)script$/.test(mime));
    if (executable) {
      const id = `S${scripts.length + 1}`;
      scripts.push({ id, offset, source });
      for (const [label, pattern] of signals) {
        let hits = 0;
        for (const match of source.matchAll(pattern)) {
          if (++hits > 5 || clues.length >= MAX_CLUES) { limits.add('代码线索已抽样'); break; }
          const at = match.index!;
          clues.push({ id: `C${clues.length + 1}`, label, offset: offset + at, script: id,
            excerpt: source.slice(Math.max(0, at - 45), at + match[0].length + 65).replace(/[A-Za-z0-9+/=]{32,}/g, '…') });
        }
      }
    }
    if (!executable) blocks.push({ offset, source, ext: !isScript ? 'css' : mime?.includes('json') ? 'json' : 'txt' });
    if (!isScript) { addCssUrls(source, offset); continue; }
    const refs = /["'`](data:[\w.+/-]+(?:;[^,\s"'`]{0,150})?,[^\s"'`)]*|[^\s"'`<>]{1,220}\.(?:png|jpe?g|webp|gif|svg|atlas|skel|plist|mp3|ogg|wav|m4a|ktx2?|json|glb|wasm|woff2?))["'`]/gi;
    for (const match of source.matchAll(refs)) {
      if (assets.length >= MAX_ASSETS) { limits.add('资源索引达到上限'); break; }
      addAsset(match[1], offset + match.index! + 1, isScript ? '脚本字面量候选' : 'HTML 声明', node.tagName);
    }
  }
  return { assets, clues, scripts, blocks, limits: [...limits] };
}
