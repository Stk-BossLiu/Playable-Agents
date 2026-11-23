export class EditorRequestError extends Error {
  code: string;
  hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'EditorRequestError';
    this.code = code;
    this.hint = hint;
  }
}

type EditorRequest = (
  target: string,
  message: string,
  ...args: unknown[]
) => Promise<unknown>;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Editor.Message.request 的统一封装：30s 超时、错误码归一化、Message 不存在转友好错误。
 * 场景/资产操作可能经引擎进程，超时后由调用方决定重试或返回 EDITOR_BUSY。
 */
export async function request<T>(
  target: string,
  message: string,
  ...args: unknown[]
): Promise<T> {
  return requestWithTimeout<T>(target, message, args, DEFAULT_TIMEOUT_MS);
}

export async function requestWithTimeout<T>(
  target: string,
  message: string,
  args: unknown[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const requestFn = Editor.Message.request as unknown as EditorRequest;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new EditorRequestError(
          'TIMEOUT',
          `Editor message timed out after ${timeoutMs}ms: ${target} - ${message}`,
          '编辑器可能正忙，稍后重试；场景操作可先 query-is-ready。',
        ),
      );
    }, timeoutMs);

    Promise.resolve(requestFn(target, message, ...args)).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value as T);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(normalizeError(error, `${target} - ${message}`));
      },
    );
  });
}

export function send(target: string, message: string, ...args: unknown[]): void {
  try {
    (Editor.Message.send as unknown as (...rest: unknown[]) => void)(target, message, ...args);
  } catch (error) {
    console.error(`[cocos-ai-agent] Editor.Message.send failed: ${target} - ${message}`, error);
  }
}

function normalizeError(error: unknown, context: string): EditorRequestError {
  const text = error instanceof Error ? error.message : String(error);
  if (/Message does not exist/i.test(text)) {
    return new EditorRequestError(
      'MESSAGE_NOT_EXIST',
      `编辑器消息不存在：${context}`,
      '当前编辑器版本可能不支持该消息；请检查 3.8.x 兼容性。',
    );
  }
  if (/timeout|timed out/i.test(text)) {
    return new EditorRequestError('TIMEOUT', text, '稍后重试。');
  }
  return new EditorRequestError('EDITOR_ERROR', text || `Editor request failed: ${context}`);
}
