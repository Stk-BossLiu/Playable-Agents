import { PACKAGE_NAME } from '../../shared/protocol';
import type {
  AgentModelKind,
  AgentModelProfiles,
  ModelApiType,
  ModelProfile,
  ModelProfileInput,
  ModelProfileView,
  ModelProfilesDTO,
  ModelValidationResult,
} from '../../shared/models';
import { AGENT_MODEL_KINDS } from '../../shared/models';
import {
  DEFAULT_MODEL_ENV,
  DEFAULT_PROVIDER,
  ModelsConfigWriter,
  VISION_MODEL_ENV,
  VISION_PROVIDER,
  profileEnvName,
  profileProvider,
} from '../pi/models-config';
import {
  fetchAvailableModels,
  validateModelEndpoint,
  type ModelListResult,
} from './model-validation';

const PROJECT_PROFILES = 'modelProfiles';
const PROJECT_DEFAULTS = 'modelDefaults';
const GLOBAL_SECRETS = 'modelSecrets';

const API_TYPES: ModelApiType[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
];

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface Defaults {
  defaultProfileId: string | null;
  visionProfileId: string | null;
  /** 每种 Agent 节点使用的模型 profile。 */
  agentProfiles: AgentModelProfiles;
}

type ProfileApi = {
  getProject(pkg: string, key: string): Promise<unknown>;
  setProject(pkg: string, key: string, value: unknown): Promise<void>;
  getConfig(pkg: string, key: string, type?: string): Promise<unknown>;
  setConfig(pkg: string, key: string, value: unknown, type?: string): Promise<void>;
};

function profileApi(): ProfileApi {
  return Editor.Profile as unknown as ProfileApi;
}

/**
 * 模型 profile（project，不含 secret）+ secret（global）。
 * Pi 的 models.json 只写 $ENV 引用；spawn 时把 secret 注入环境变量。
 */
export class ModelProfileStore {
  private profiles: ModelProfile[] = [];
  private secrets: Record<string, string> = {};
  private defaults: Defaults = { defaultProfileId: null, visionProfileId: null, agentProfiles: {} };
  private initialized = false;
  private readonly writer = new ModelsConfigWriter();

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const stored = await profileApi().getProject(PACKAGE_NAME, PROJECT_PROFILES);
      if (Array.isArray(stored)) this.profiles = stored.map((item) => sanitizeProfile(item)).filter(Boolean) as ModelProfile[];
      const defaults = await profileApi().getProject(PACKAGE_NAME, PROJECT_DEFAULTS);
      if (defaults && typeof defaults === 'object') {
        const record = defaults as Record<string, unknown>;
        this.defaults = {
          defaultProfileId: typeof record.defaultProfileId === 'string' ? record.defaultProfileId : null,
          visionProfileId: typeof record.visionProfileId === 'string' ? record.visionProfileId : null,
          agentProfiles: sanitizeAgentProfiles(record.agentProfiles),
        };
      }
      const secrets = await profileApi().getConfig(PACKAGE_NAME, GLOBAL_SECRETS, 'global');
      if (secrets && typeof secrets === 'object') {
        this.secrets = sanitizeSecrets(secrets as Record<string, unknown>);
      }
    } catch (error) {
      console.warn(`[${PACKAGE_NAME}] read model profiles failed`, error);
    }
    this.ensureDefaults();
  }

  getProfiles(): ModelProfile[] {
    return this.profiles.map((profile) => clone(profile));
  }

  getDTO(): ModelProfilesDTO {
    return {
      profiles: this.profiles.map((profile) => this.view(profile)),
      defaultProfileId: this.defaults.defaultProfileId,
      visionProfileId: this.defaults.visionProfileId,
      agentProfiles: { ...this.defaults.agentProfiles },
      piModelsPath: this.writer.configPath,
    };
  }

  async upsert(input: ModelProfileInput): Promise<ModelProfileView> {
    const existingIndex = input.id
      ? this.profiles.findIndex((profile) => profile.id === input.id)
      : -1;
    const existing = existingIndex >= 0 ? this.profiles[existingIndex] : undefined;
    const id = existing?.id ?? this.uniqueId(input.id || slug(input.name || input.modelId || 'profile'));
    const secret = typeof input.secret === 'string' ? input.secret.trim() : undefined;
    const credentialsChanged =
      !existing ||
      (typeof secret === 'string' && secret.length > 0) ||
      (input.baseUrl !== undefined && sanitizeBaseUrl(input.baseUrl) !== existing.baseUrl) ||
      (input.modelId !== undefined && input.modelId.trim() !== existing.modelId);

    const next: ModelProfile = sanitizeProfile({
      ...(existing ?? {}),
      ...input,
      id,
      validatedAt: credentialsChanged ? undefined : existing?.validatedAt,
      lastValidation: credentialsChanged ? undefined : existing?.lastValidation,
    }) as ModelProfile;
    if (!next) throw new Error('模型 profile 参数无效。');

    if (existingIndex >= 0) this.profiles[existingIndex] = next;
    else this.profiles.push(next);
    if (typeof secret === 'string' && secret) {
      this.secrets[id] = secret;
    }

    if (!this.defaults.defaultProfileId) this.defaults.defaultProfileId = id;
    if (next.vision && !this.defaults.visionProfileId) this.defaults.visionProfileId = id;

    await this.persist();
    return this.view(next);
  }

  async remove(id: string): Promise<boolean> {
    const index = this.profiles.findIndex((profile) => profile.id === id);
    if (index < 0) return false;
    this.profiles.splice(index, 1);
    delete this.secrets[id];
    if (this.defaults.defaultProfileId === id) this.defaults.defaultProfileId = null;
    if (this.defaults.visionProfileId === id) this.defaults.visionProfileId = null;
    this.ensureDefaults();
    await this.persist();
    return true;
  }

  async setDefaults(input: {
    defaultProfileId?: string | null;
    visionProfileId?: string | null;
    agentProfiles?: Record<string, string | null>;
  }): Promise<ModelProfilesDTO> {
    if (input.defaultProfileId !== undefined) {
      this.defaults.defaultProfileId =
        input.defaultProfileId && this.profiles.some((profile) => profile.id === input.defaultProfileId)
          ? input.defaultProfileId
          : null;
    }
    if (input.visionProfileId !== undefined) {
      this.defaults.visionProfileId =
        input.visionProfileId && this.profiles.some((profile) => profile.id === input.visionProfileId)
          ? input.visionProfileId
          : null;
    }
    if (input.agentProfiles !== undefined) {
      const next: AgentModelProfiles = { ...this.defaults.agentProfiles };
      for (const [kind, id] of Object.entries(input.agentProfiles)) {
        if (!AGENT_MODEL_KINDS.includes(kind as AgentModelKind)) continue;
        const valid =
          typeof id === 'string' && id && this.profiles.some((profile) => profile.id === id)
            ? id
            : null;
        if (valid) next[kind as AgentModelKind] = valid;
        else delete next[kind as AgentModelKind];
      }
      this.defaults.agentProfiles = next;
    }
    this.ensureDefaults();
    await profileApi().setProject(PACKAGE_NAME, PROJECT_DEFAULTS, this.defaults);
    // 同步 models.json，保证新选择的 profile 已作为 provider 写入（进程重启后生效）。
    try {
      await this.apply();
    } catch (error) {
      console.warn(`[${PACKAGE_NAME}] sync models.json failed`, error);
    }
    return this.getDTO();
  }

  async validate(id: string): Promise<{ profile: ModelProfileView; validation: ModelValidationResult }> {
    const profile = this.profiles.find((item) => item.id === id);
    if (!profile) throw new Error(`找不到模型 profile：${id}`);
    const secret = this.secrets[id] ?? '';
    const validation = await validateModelEndpoint(profile, secret);
    profile.lastValidation = validation;
    profile.validatedAt = validation.ok ? validation.checkedAt : undefined;
    await this.persist();
    return { profile: this.view(profile), validation };
  }

  /** 拉取端点支持的模型列表；secret 可用新输入的，或复用已保存的 profile secret。 */
  async listModels(input: {
    baseUrl?: string;
    secret?: string;
    profileId?: string;
    apiType?: ModelApiType;
  }): Promise<ModelListResult> {
    const profile = input.profileId ? this.getProfile(input.profileId) : null;
    const baseUrl = (input.baseUrl ?? profile?.baseUrl ?? '').trim();
    const secret =
      (input.secret ?? '').trim() ||
      (input.profileId ? this.secrets[input.profileId] ?? '' : '');
    const apiType = input.apiType ?? profile?.apiType ?? 'openai-completions';
    return fetchAvailableModels(baseUrl, secret, apiType);
  }

  /** 把选中的模型批量加入插件配置：每个模型一个 profile，共用同一份凭证。 */
  async addModels(input: {
    baseUrl?: string;
    secret?: string;
    profileId?: string;
    namePrefix?: string;
    apiType?: ModelApiType;
    vision?: boolean;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    modelIds?: string[];
  }): Promise<{ models: ModelProfilesDTO; created: number; skipped: string[] }> {
    const profile = input.profileId ? this.getProfile(input.profileId) : null;
    const baseUrl = sanitizeBaseUrl(input.baseUrl ?? profile?.baseUrl ?? '');
    const secret =
      (input.secret ?? '').trim() ||
      (input.profileId ? this.secrets[input.profileId] ?? '' : '');
    if (!baseUrl) throw new Error('baseUrl 不能为空。');
    if (!secret) throw new Error('请先输入 API Key。');
    const apiType = API_TYPES.includes(input.apiType as ModelApiType)
      ? (input.apiType as ModelApiType)
      : profile?.apiType ?? 'openai-completions';
    const prefix = (input.namePrefix ?? '').trim();
    const modelIds = [...new Set((input.modelIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
    if (!modelIds.length) throw new Error('请选择至少一个模型。');
    if (modelIds.length > 100) throw new Error('一次最多选择 100 个模型。');

    const created: string[] = [];
    const skipped: string[] = [];
    const vision = input.vision ?? profile?.vision ?? false;
    for (const modelId of modelIds) {
      if (this.profiles.some((item) => item.modelId === modelId && item.baseUrl === baseUrl)) {
        skipped.push(modelId);
        continue;
      }
      const id = this.uniqueId(slug(modelId));
      const next = sanitizeProfile({
        id,
        name: prefix ? `${prefix} · ${modelId}` : modelId,
        ...(prefix ? { providerName: prefix } : {}),
        baseUrl,
        modelId,
        apiType,
        vision,
        contextWindow: input.contextWindow ?? profile?.contextWindow ?? 128_000,
        maxTokens: input.maxTokens ?? profile?.maxTokens ?? 8_192,
        reasoning: input.reasoning ?? profile?.reasoning ?? false,
      });
      if (!next) {
        skipped.push(modelId);
        continue;
      }
      this.profiles.push(next);
      this.secrets[next.id] = secret;
      created.push(next.id);
    }

    if (created[0] && !this.defaults.defaultProfileId) this.defaults.defaultProfileId = created[0];
    if (created[0] && vision && !this.defaults.visionProfileId) this.defaults.visionProfileId = created[0];
    this.ensureDefaults();
    await this.persist();
    try {
      await this.apply();
    } catch (error) {
      console.warn(`[${PACKAGE_NAME}] sync models.json failed`, error);
    }
    return { models: this.getDTO(), created: created.length, skipped };
  }

  /** 更新一组模型（同一提供商）的 baseURL / apiType / 凭证 / 显示名前缀。 */
  /**
   * 保存一个提供商：凭证 + 名称 + 它下面完整的模型列表。
   * 传入的 models 是最终列表，未出现的旧模型会被删除。
   */
  async saveProviderModels(input: {
    profileIds?: string[];
    name?: string;
    baseUrl?: string;
    apiType?: ModelApiType;
    secret?: string;
    models?: Array<{
      id?: string;
      name?: string;
      modelId?: string;
      vision?: boolean;
      reasoning?: boolean;
      contextWindow?: number;
      maxTokens?: number;
    }>;
  }): Promise<ModelProfilesDTO> {
    const existingIds = new Set((input.profileIds ?? []).filter(Boolean));
    const existing = this.profiles.filter((profile) => existingIds.has(profile.id));
    const baseUrl = sanitizeBaseUrl(input.baseUrl ?? existing[0]?.baseUrl ?? '');
    if (!baseUrl) throw new Error('baseUrl 不能为空。');
    const apiType = API_TYPES.includes(input.apiType as ModelApiType)
      ? (input.apiType as ModelApiType)
      : existing[0]?.apiType ?? 'openai-completions';
    const providerName =
      (input.name ?? '').trim() || existing[0]?.providerName || hostnameOf(baseUrl);
    const secretInput = typeof input.secret === 'string' ? input.secret.trim() : '';
    const secret = secretInput || existing.map((profile) => this.secrets[profile.id]).find(Boolean) || '';
    if (!secret) throw new Error('请先输入 API Key。');
    const draft = (input.models ?? [])
      .map((model) => ({
        id: typeof model.id === 'string' ? model.id : '',
        modelId: String(model.modelId ?? '').trim(),
        name: String(model.name ?? '').trim(),
        vision: Boolean(model.vision),
        reasoning: Boolean(model.reasoning),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }))
      .filter((model) => model.modelId);
    if (!draft.length) throw new Error('请至少添加一个模型。');

    const next: ModelProfile[] = [];
    const kept = new Set<string>();
    const seenModelIds = new Set<string>();
    for (const model of draft) {
      if (seenModelIds.has(model.modelId)) continue;
      seenModelIds.add(model.modelId);
      const id = model.id && existingIds.has(model.id) ? model.id : this.uniqueId(slug(model.modelId));
      if (kept.has(id)) continue;
      const current = this.profiles.find((profile) => profile.id === id);
      const profile = sanitizeProfile({
        ...(current ?? {}),
        id,
        providerName,
        name: model.name || (providerName ? `${providerName} · ${model.modelId}` : model.modelId),
        baseUrl,
        modelId: model.modelId,
        apiType,
        vision: model.vision,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow ?? current?.contextWindow ?? 128_000,
        maxTokens: model.maxTokens ?? current?.maxTokens ?? 8_192,
      });
      if (!profile) continue;
      kept.add(id);
      next.push(profile);
      this.secrets[id] = secret;
    }
    if (!next.length) throw new Error('没有有效的模型。');

    const removed = existing.filter((profile) => !kept.has(profile.id));
    for (const profile of removed) delete this.secrets[profile.id];
    this.profiles = this.profiles.filter(
      (profile) => !existingIds.has(profile.id) || kept.has(profile.id),
    );
    for (const profile of next) {
      const index = this.profiles.findIndex((item) => item.id === profile.id);
      if (index >= 0) this.profiles[index] = profile;
      else this.profiles.push(profile);
    }

    const removedIds = new Set(removed.map((profile) => profile.id));
    if (this.defaults.defaultProfileId && removedIds.has(this.defaults.defaultProfileId)) {
      this.defaults.defaultProfileId = null;
    }
    if (this.defaults.visionProfileId && removedIds.has(this.defaults.visionProfileId)) {
      this.defaults.visionProfileId = null;
    }
    for (const kind of AGENT_MODEL_KINDS) {
      const id = this.defaults.agentProfiles[kind];
      if (id && removedIds.has(id)) delete this.defaults.agentProfiles[kind];
    }
    if (!this.defaults.defaultProfileId && next[0]) this.defaults.defaultProfileId = next[0].id;
    this.ensureDefaults();
    await this.persist();
    try {
      await this.apply();
    } catch (error) {
      console.warn(`[${PACKAGE_NAME}] sync models.json failed`, error);
    }
    return this.getDTO();
  }

  /** 删除一整个提供商的模型。 */
  async removeProfiles(ids: string[]): Promise<ModelProfilesDTO> {
    const targetIds = new Set((ids ?? []).filter(Boolean));
    if (!targetIds.size) return this.getDTO();
    this.profiles = this.profiles.filter((profile) => !targetIds.has(profile.id));
    for (const id of targetIds) delete this.secrets[id];
    if (this.defaults.defaultProfileId && targetIds.has(this.defaults.defaultProfileId)) {
      this.defaults.defaultProfileId = null;
    }
    if (this.defaults.visionProfileId && targetIds.has(this.defaults.visionProfileId)) {
      this.defaults.visionProfileId = null;
    }
    for (const kind of AGENT_MODEL_KINDS) {
      const id = this.defaults.agentProfiles[kind];
      if (id && targetIds.has(id)) delete this.defaults.agentProfiles[kind];
    }
    this.ensureDefaults();
    await this.persist();
    try {
      await this.apply();
    } catch (error) {
      console.warn(`[${PACKAGE_NAME}] sync models.json failed`, error);
    }
    return this.getDTO();
  }

  async apply(): Promise<{ path: string; provider: string; modelId: string }> {
    const defaults = this.activeProfiles();
    const path = await this.writer.write({
      ...defaults,
      all: this.profiles.map((profile) => clone(profile)),
    });
    return {
      path,
      provider: defaults.default ? DEFAULT_PROVIDER : '',
      modelId: defaults.default?.modelId ?? '',
    };
  }

  getSpawnConfig(): { provider: string; model: string; env: Record<string, string> } {
    const defaults = this.activeProfiles();
    const env: Record<string, string> = {};
    if (defaults.default && this.secrets[defaults.default.id]) {
      env[DEFAULT_MODEL_ENV] = this.secrets[defaults.default.id];
    }
    if (defaults.vision && this.secrets[defaults.vision.id]) {
      env[VISION_MODEL_ENV] = this.secrets[defaults.vision.id];
    }
    // 每个 profile 的 secret 都注入环境变量，Agent 节点切换模型时才能读到 key。
    for (const profile of this.profiles) {
      const secret = this.secrets[profile.id];
      if (secret) env[profileEnvName(profile.id)] = secret;
    }
    return {
      provider: defaults.default ? DEFAULT_PROVIDER : '',
      model: defaults.default?.modelId ?? '',
      env,
    };
  }

  getActiveDefault(): ModelProfile | null {
    return this.activeProfiles().default ?? null;
  }

  getActiveVision(): ModelProfile | null {
    return this.activeProfiles().vision ?? null;
  }

  getSecret(id: string): string | undefined {
    return this.secrets[id];
  }

  getModelsConfigPath(): string {
    return this.writer.configPath;
  }

  getProfile(id: string): ModelProfile | null {
    const profile = this.profiles.find((item) => item.id === id);
    return profile ? clone(profile) : null;
  }

  getAgentProfileId(kind: AgentModelKind): string | null {
    return this.defaults.agentProfiles[kind] ?? null;
  }

  /** profile → Pi provider / modelId；模型未写入 models.json 时由调用方报错处理。 */
  resolveProfile(id: string): { provider: string; modelId: string } | null {
    const profile = this.getProfile(id);
    return profile ? { provider: profileProvider(profile.id), modelId: profile.modelId } : null;
  }

  private activeProfiles(): { default?: ModelProfile; vision?: ModelProfile } {
    const defaultProfile =
      this.profiles.find((profile) => profile.id === this.defaults.defaultProfileId) ??
      this.profiles[0];
    const visionProfile = this.defaults.visionProfileId
      ? this.profiles.find((profile) => profile.id === this.defaults.visionProfileId)
      : undefined;
    return {
      ...(defaultProfile ? { default: clone(defaultProfile) } : {}),
      ...(visionProfile ? { vision: clone(visionProfile) } : {}),
    };
  }

  private view(profile: ModelProfile): ModelProfileView {
    const secret = this.secrets[profile.id];
    return {
      ...clone(profile),
      secretConfigured: Boolean(secret),
      maskedSecret: secret ? maskSecret(secret) : '',
      providerId: profileProvider(profile.id),
    };
  }

  private ensureDefaults(): void {
    if (this.defaults.defaultProfileId && !this.profiles.some((p) => p.id === this.defaults.defaultProfileId)) {
      this.defaults.defaultProfileId = null;
    }
    if (!this.defaults.defaultProfileId && this.profiles[0]) this.defaults.defaultProfileId = this.profiles[0].id;
    if (this.defaults.visionProfileId && !this.profiles.some((p) => p.id === this.defaults.visionProfileId)) {
      this.defaults.visionProfileId = null;
    }
    for (const kind of AGENT_MODEL_KINDS) {
      const id = this.defaults.agentProfiles[kind];
      if (id && !this.profiles.some((profile) => profile.id === id)) {
        delete this.defaults.agentProfiles[kind];
      }
    }
  }

  private async persist(): Promise<void> {
    await Promise.all([
      profileApi().setProject(PACKAGE_NAME, PROJECT_PROFILES, this.profiles),
      profileApi().setProject(PACKAGE_NAME, PROJECT_DEFAULTS, this.defaults),
      profileApi().setConfig(PACKAGE_NAME, GLOBAL_SECRETS, this.secrets, 'global'),
    ]);
  }

  private uniqueId(base: string): string {
    const safe = slug(base);
    let candidate = safe;
    let index = 2;
    while (this.profiles.some((profile) => profile.id === candidate)) {
      candidate = `${safe}-${index}`;
      index += 1;
    }
    return candidate;
  }
}

function sanitizeProfile(value: unknown): ModelProfile | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' && PROFILE_ID_PATTERN.test(record.id) ? record.id : '';
  if (!id) return null;
  const baseUrl = sanitizeBaseUrl(String(record.baseUrl ?? ''));
  const modelId = String(record.modelId ?? '').trim();
  if (!baseUrl && !modelId) return null;
  const apiType = API_TYPES.includes(record.apiType as ModelApiType)
    ? (record.apiType as ModelApiType)
    : 'openai-completions';
  const lastValidation = sanitizeValidation(record.lastValidation);
  return {
    id,
    name: String(record.name ?? '').trim() || modelId || id,
    ...(typeof record.providerName === 'string' && record.providerName.trim()
      ? { providerName: record.providerName.trim() }
      : {}),
    baseUrl,
    modelId,
    apiType,
    vision: Boolean(record.vision),
    contextWindow: clampNumber(record.contextWindow, 128_000, 1_000, 4_000_000),
    maxTokens: clampNumber(record.maxTokens, 8_192, 1, 1_000_000),
    reasoning: Boolean(record.reasoning),
    ...(typeof record.validatedAt === 'string' ? { validatedAt: record.validatedAt } : {}),
    ...(lastValidation ? { lastValidation } : {}),
  };
}

function sanitizeValidation(value: unknown): ModelValidationResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return {
    ok: Boolean(record.ok),
    ...(typeof record.latencyMs === 'number' ? { latencyMs: record.latencyMs } : {}),
    ...(Array.isArray(record.models) ? { models: record.models.filter((item): item is string => typeof item === 'string').slice(0, 50) } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
    ...(typeof record.warning === 'string' ? { warning: record.warning } : {}),
    ...(typeof record.checkedAt === 'string' ? { checkedAt: record.checkedAt } : {}),
  };
}

function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname || value;
  } catch {
    return value;
  }
}

function sanitizeAgentProfiles(value: unknown): AgentModelProfiles {
  const result: AgentModelProfiles = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const record = value as Record<string, unknown>;
  for (const kind of AGENT_MODEL_KINDS) {
    const id = record[kind];
    if (typeof id === 'string' && id.trim()) result[kind] = id.trim();
  }
  return result;
}

function sanitizeSecrets(value: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, secret] of Object.entries(value ?? {})) {
    const text = typeof secret === 'string' ? secret.trim() : '';
    if (key.trim() && text) result[key.trim()] = text;
  }
  return result;
}

function sanitizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function slug(value: string): string {
  const text = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64);
  return PROFILE_ID_PATTERN.test(text) ? text : `profile-${Date.now().toString(36)}`;
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return '********';
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
