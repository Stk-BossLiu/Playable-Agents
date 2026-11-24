import { defineTool } from '../bridge/schema';
import { fail, ok } from '../bridge/result';

const levels = ['log', 'info', 'warn', 'error'] as const;
const defaultLimit = 20;
const maxLimit = 100;
const maxMessageLength = 2000;
const maxStackLength = 1800;
const maxTextBudget = 24000;

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export const queryConsole = defineTool({
  name: 'editor_query_console',
  label: '查询 Creator 控制台',
  description: '实时读取 Creator 编辑器控制台的内存日志。返回最近匹配的记录，由早到晚排列。可按级别、正文关键词和起始时间筛选，并选择附带堆栈。',
  risk: 'read',
  skipGate: true,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      level: { type: 'string', enum: [...levels], description: '省略时查询全部级别' },
      keyword: { type: 'string', description: '在日志正文中匹配字符串，忽略大小写' },
      since: { type: 'number', minimum: 0, description: '包含此时间及之后的日志，Unix 毫秒' },
      limit: { type: 'integer', minimum: 1, maximum: maxLimit, default: defaultLimit },
      includeStack: { type: 'boolean', default: false },
    },
  },
  async handler({ level, keyword, since, limit = defaultLimit, includeStack = false }) {
    if ((level !== undefined && !levels.some(value => value === level)) ||
        (keyword !== undefined && typeof keyword !== 'string') ||
        (since !== undefined && (typeof since !== 'number' || !Number.isFinite(since) || since < 0)) ||
        (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > maxLimit) ||
        typeof includeStack !== 'boolean') return fail('INVALID_ARGS', '请检查控制台查询的级别、关键词、起始时间、条数和堆栈选项。');

    if (typeof Editor.Logger?.query !== 'function') return fail('EDITOR_ERROR', '当前编辑器未提供实时日志查询接口。');
    const records = await Editor.Logger.query();
    if (!Array.isArray(records)) return fail('EDITOR_ERROR', '编辑器返回了无法识别的控制台日志格式。');
    const needle = keyword?.toLowerCase();
    const entries = [];
    let budget = maxTextBudget;
    let hasMore = false;
    for (let i = records.length - 1; i >= 0; i--) {
      const row = records[i];
      if (level && level !== row.type) continue;
      if (since !== undefined && row.time < since) continue;
      const message = String(row.message ?? '');
      if (needle && !message.toLowerCase().includes(needle)) continue;
      if (entries.length >= limit || budget <= 0) { hasMore = true; break; }
      const body = clip(message, Math.min(maxMessageLength, budget));
      budget -= body.length;
      const stack = includeStack && row.stack && budget > 0 ? clip(row.stack, Math.min(maxStackLength, budget)) : undefined;
      budget -= stack?.length ?? 0;
      entries.push({ time: row.time, level: row.type, process: row.process, message: body, stack,
        truncated: body.length !== message.length || Boolean(includeStack && row.stack && stack !== row.stack) });
    }
    return ok({ source: 'Editor.Logger.query', total: records.length, hasMore, entries: entries.reverse() });
  },
});
