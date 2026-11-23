import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ModelProfile } from '../../shared/models';
import { readJson, writeJsonAtomic } from '../utils/fs';

interface ModelsFile {
  providers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ModelsConfigProfiles {
  default?: ModelProfile;
  vision?: ModelProfile;
  /** 全部 profile；每个 profile 额外写一个可被 Agent 节点切换的 provider。 */
  all?: ModelProfile[];
}

export const DEFAULT_MODEL_ENV = 'COCOS_AI_AGENT_MODEL_KEY_DEFAULT';
export const VISION_MODEL_ENV = 'COCOS_AI_AGENT_MODEL_KEY_VISION';
export const DEFAULT_PROVIDER = 'cocos-default';
export const VISION_PROVIDER = 'cocos-vision';
export const PROFILE_PROVIDER_PREFIX = 'cocos-profile-';

/** 单个 profile 在 models.json 中的 provider 名。 */
export function profileProvider(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase();
  return `${PROFILE_PROVIDER_PREFIX}${safe || 'profile'}-${profileHash(id)}`;
}

/** 单个 profile 的 secret 环境变量名（避免 id 里的特殊字符与冲突）。 */
export function profileEnvName(id: string): string {
  return `COCOS_AI_AGENT_MODEL_KEY_P_${profileHash(id)}`;
}

function profileHash(id: string): string {
  return createHash('sha1').update(id).digest('hex').slice(0, 10);
}

/**
 * 合并写入 <agent-dir>/models.json。secret 只写 $ENV 引用，不落明文。
 * agent-dir 默认 ~/.pi/agent，支持 PI_CODING_AGENT_DIR 覆盖。
 */
export class ModelsConfigWriter {
  readonly configPath: string;
  readonly backupPath: string;

  constructor(agentDir?: string) {
    const base = agentDir?.trim() || process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');
    this.configPath = join(base, 'models.json');
    this.backupPath = `${this.configPath}.cocos-ai-agent.bak`;
  }

  async write(profiles: ModelsConfigProfiles): Promise<string> {
    await fsp.mkdir(dirname(this.configPath), { recursive: true });
    await this.ensureBackup();
    const existing = (await readJson<ModelsFile>(this.configPath)) ?? {};
    const providers = isRecord(existing.providers) ? { ...existing.providers } : {};

    if (profiles.default) {
      providers[DEFAULT_PROVIDER] = providerFor(profiles.default, DEFAULT_MODEL_ENV, false);
    } else {
      delete providers[DEFAULT_PROVIDER];
    }
    if (profiles.vision) {
      providers[VISION_PROVIDER] = providerFor(profiles.vision, VISION_MODEL_ENV, true);
    } else {
      delete providers[VISION_PROVIDER];
    }

    // 清理旧的 per-profile provider，再写入当前全部 profile，供 Agent 节点按需切换。
    for (const key of Object.keys(providers)) {
      if (key.startsWith(PROFILE_PROVIDER_PREFIX)) delete providers[key];
    }
    for (const profile of profiles.all ?? []) {
      providers[profileProvider(profile.id)] = providerFor(
        profile,
        profileEnvName(profile.id),
        profile.vision,
      );
    }

    await writeJsonAtomic(this.configPath, { ...existing, providers });
    return this.configPath;
  }

  async read(): Promise<ModelsFile | null> {
    return readJson<ModelsFile>(this.configPath);
  }

  private async ensureBackup(): Promise<void> {
    if (await fileExists(this.backupPath)) return;
    if (!(await fileExists(this.configPath))) return;
    await fsp.copyFile(this.configPath, this.backupPath);
  }
}

export function providerFor(profile: ModelProfile, envName: string, vision: boolean): Record<string, unknown> {
  return {
    name: profile.name || (vision ? 'Cocos AI Agent Vision' : 'Cocos AI Agent Default'),
    baseUrl: profile.baseUrl,
    api: profile.apiType,
    apiKey: `$${envName}`,
    models: [
      {
        id: profile.modelId,
        name: profile.name || profile.modelId,
        reasoning: Boolean(profile.reasoning),
        input: vision || profile.vision ? ['text', 'image'] : ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: profile.contextWindow,
        maxTokens: profile.maxTokens,
      },
    ],
  };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
