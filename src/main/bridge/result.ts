export type ToolErrorCode =
  | 'EDITOR_BUSY'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_DENIED'
  | 'APPROVAL_TIMEOUT'
  | 'MESSAGE_NOT_EXIST'
  | 'INVALID_ARGS'
  | 'NOT_FOUND'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_DISABLED'
  | 'EDITOR_ERROR'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR';

export interface ToolError {
  code: ToolErrorCode | string;
  message: string;
  hint?: string;
  data?: unknown;
}

export type ToolResult<T = unknown> =
  | { ok: true; data: T; meta?: Record<string, unknown> }
  | { ok: false; error: ToolError };

export function ok<T>(data: T, meta?: Record<string, unknown>): ToolResult<T> {
  return { ok: true, data, ...(meta ? { meta } : {}) };
}

export function fail(
  code: ToolErrorCode | string,
  message: string,
  hint?: string,
  data?: unknown,
): ToolResult<never> {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}), ...(data !== undefined ? { data } : {}) } };
}

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface McpToolContent {
  content: Array<McpTextContent | McpImageContent>;
  isError: boolean;
}

/** 把内部 Result 映射为 MCP content；错误也返回结构化 JSON，方便模型自行纠正。 */
export function toMcpContent(result: ToolResult): McpToolContent {
  if (result.ok) {
    return {
      content: [{ type: 'text', text: stringify(result.data) }],
      isError: false,
    };
  }
  return {
    content: [{ type: 'text', text: stringify({ ok: false, error: result.error }) }],
    isError: true,
  };
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
