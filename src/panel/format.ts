/** 工具参数/结果的 JSON 格式化；非 JSON 文本原样返回。 */
export function formatJsonValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return formatJsonText(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatJsonText(value: string): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (!text.startsWith('{') && !text.startsWith('[')) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
