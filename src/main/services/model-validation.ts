import type { ModelApiType, ModelProfile, ModelValidationResult } from '../../shared/models';

type FetchLike = typeof fetch;

const TIMEOUT_MS = 15_000;

export interface ModelListResult {
  ok: boolean;
  models: string[];
  /** 实际命中的 base（可能是自动补 /v1 后的地址）。 */
  baseUrl?: string;
  latencyMs?: number;
  error?: string;
}

/**
 * 仅获取端点支持的模型列表（不需要 modelId，也不发 chat 请求）。
 * 用于“填写 baseURL + API Key 后自动加载模型”。
 */
export async function fetchAvailableModels(
  baseUrl: string,
  secret: string,
  apiType: ModelApiType = 'openai-completions',
  fetchImpl: FetchLike = fetch,
): Promise<ModelListResult> {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return { ok: false, models: [], error: 'baseUrl 不能为空。' };
  if (!secret.trim()) return { ok: false, models: [], error: 'secret 不能为空。' };
  const started = Date.now();
  const failures: string[] = [];
  for (const base of candidateBases(normalized)) {
    const result = await listModels(base, secret, apiType, fetchImpl);
    if (result.ok) {
      return {
        ok: true,
        models: result.models.slice(0, 500),
        baseUrl: base,
        latencyMs: Date.now() - started,
      };
    }
    if (result.error) failures.push(result.error);
  }
  return {
    ok: false,
    models: [],
    latencyMs: Date.now() - started,
    error: failures.slice(0, 3).join('；') || '获取模型列表失败。',
  };
}

async function listModels(
  base: string,
  secret: string,
  apiType: ModelApiType,
  fetchImpl: FetchLike,
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  try {
    const url = apiType === 'google-generative-ai'
      ? `${base}/models?key=${encodeURIComponent(secret)}`
      : `${base}/models`;
    const headers: Record<string, string> =
      apiType === 'google-generative-ai'
        ? {}
        : apiType === 'anthropic-messages'
          ? { 'x-api-key': secret, 'anthropic-version': '2023-06-01' }
          : { Authorization: `Bearer ${secret}` };
    const response = await requestWithTimeout(fetchImpl, url, { method: 'GET', headers });
    if (!response.ok) return { ok: false, models: [], error: `GET ${base}/models 返回 ${response.status}` };
    const text = await response.text();
    return { ok: true, models: [...new Set(extractModelIds(text))] };
  } catch (error) {
    return { ok: false, models: [], error: `GET ${base}/models 失败：${errorText(error)}` };
  }
}

/**
 * 校验兼容端点：GET /models，失败后回退 1-token POST /chat/completions。
 * secret 只进入请求头，不进入错误信息/日志。
 */
export async function validateModelEndpoint(
  profile: Pick<ModelProfile, 'baseUrl' | 'modelId' | 'apiType' | 'vision'>,
  secret: string,
  fetchImpl: FetchLike = fetch,
): Promise<ModelValidationResult> {
  const baseUrl = normalizeBaseUrl(profile.baseUrl);
  if (!baseUrl) return { ok: false, error: 'baseUrl 不能为空。', checkedAt: new Date().toISOString() };
  if (!profile.modelId.trim()) return { ok: false, error: 'modelId 不能为空。', checkedAt: new Date().toISOString() };
  if (!secret.trim()) return { ok: false, error: 'secret 不能为空。', checkedAt: new Date().toISOString() };

  const started = Date.now();
  const candidates = candidateBases(baseUrl);
  const failures: string[] = [];
  for (const base of candidates) {
    const models = await tryListModels(base, profile.modelId, secret, fetchImpl);
    if (models.ok) {
      return {
        ...models,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
      };
    }
    if (models.error) failures.push(models.error);
    const chat = await tryChatPing(base, profile, secret, fetchImpl);
    if (chat.ok) {
      return {
        ...chat,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
      };
    }
    if (chat.error) failures.push(chat.error);
  }
  return {
    ok: false,
    latencyMs: Date.now() - started,
    error: failures.slice(0, 3).join('；') || '端点校验失败。',
    checkedAt: new Date().toISOString(),
  };
}

export function normalizeBaseUrl(value: string): string {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

export function candidateBases(baseUrl: string): string[] {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return [];
  if (/\/v\d+(?:\.\d+)?$/i.test(normalized)) return [normalized];
  return [normalized, `${normalized}/v1`];
}

async function tryListModels(
  base: string,
  modelId: string,
  secret: string,
  fetchImpl: FetchLike,
): Promise<ModelValidationResult> {
  try {
    const response = await requestWithTimeout(fetchImpl, `${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!response.ok) {
      return { ok: false, error: `GET ${base}/models 返回 ${response.status}` };
    }
    const text = await response.text();
    const models = extractModelIds(text);
    if (models.length && !models.includes(modelId)) {
      return {
        ok: true,
        models: models.slice(0, 50),
        warning: `模型列表中未找到 ${modelId}（仍可尝试调用）。`,
      };
    }
    return { ok: true, ...(models.length ? { models: models.slice(0, 50) } : {}) };
  } catch (error) {
    return { ok: false, error: `GET ${base}/models 失败：${errorText(error)}` };
  }
}

async function tryChatPing(
  base: string,
  profile: Pick<ModelProfile, 'modelId' | 'apiType' | 'vision'>,
  secret: string,
  fetchImpl: FetchLike,
): Promise<ModelValidationResult> {
  try {
    const response = await requestWithTimeout(fetchImpl, `${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: profile.modelId,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, error: `POST ${base}/chat/completions 返回 ${response.status}${body ? `：${body.slice(0, 160)}` : ''}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `POST ${base}/chat/completions 失败：${errorText(error)}` };
  }
}

async function requestWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractModelIds(text: string): string[] {
  try {
    const payload = JSON.parse(text) as unknown;
    const list = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object'
        ? Array.isArray((payload as { data?: unknown }).data)
          ? (payload as { data: unknown[] }).data
          : Array.isArray((payload as { models?: unknown }).models)
            ? (payload as { models: unknown[] }).models
            : []
        : [];
    return list
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          return typeof record.id === 'string' ? record.id : typeof record.name === 'string' ? record.name : '';
        }
        return '';
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return `请求超时（${TIMEOUT_MS}ms）`;
    return error.message;
  }
  return String(error);
}
