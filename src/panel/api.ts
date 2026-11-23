import { PACKAGE_NAME } from '../shared/protocol';

/** 面板 -> 主进程 request（有返回值）。 */
export async function request<T>(message: string, ...args: unknown[]): Promise<T> {
  return (Editor.Message.request as unknown as (
    target: string,
    message: string,
    ...rest: unknown[]
  ) => Promise<T>)(PACKAGE_NAME, message, ...args);
}

/** 扩展刚加载时主进程消息可能尚未注册；对初始化请求做短重试。 */
export async function requestRetry<T>(
  message: string,
  args: unknown[] = [],
  attempts = 12,
  delayMs = 250,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await request<T>(message, ...args);
    } catch (error) {
      lastError = error;
      const text = error instanceof Error ? error.message : String(error);
      if (!/Message does not exist/i.test(text)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/** 面板 -> 主进程 send（无返回值）。 */
export function send(message: string, ...args: unknown[]): void {
  (Editor.Message.send as unknown as (target: string, message: string, ...rest: unknown[]) => void)(
    PACKAGE_NAME,
    message,
    ...args,
  );
}
