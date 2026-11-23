import { PACKAGE_NAME } from '../../shared/protocol';
import type { Settings, SettingsDTO, SettingsPatch, ThinkingSetting } from '../../shared/types';

const PROJECT_KEY = 'settings';
const GLOBAL_KEY = 'apiKeys';

export const DEFAULT_SETTINGS: Settings = {
  provider: '',
  model: '',
  thinking: 'default',
  piVersion: '1.4.0',
  piPath: '',
  piMirror: '',
  autoStartAgent: false,
  resumeLastSession: true,
  maxTreeNodes: 500,
  language: 'zh',
  theme: 'auto',
  confirmMode: 'destructive',
  approvalWhenPanelClosed: 'deny',
};

const THINKING_LEVELS: ThinkingSetting[] = [
  'default',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

type ProfileApi = {
  getProject(pkg: string, key: string): Promise<unknown>;
  setProject(pkg: string, key: string, value: unknown): Promise<void>;
  getConfig(pkg: string, key: string, type?: string): Promise<unknown>;
  setConfig(pkg: string, key: string, value: unknown, type?: string): Promise<void>;
};

function profile(): ProfileApi {
  return Editor.Profile as unknown as ProfileApi;
}

export class SettingsStore {
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private apiKeys: Record<string, string> = {};
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    let stored: Partial<Settings> = {};
    let keys: Record<string, string> = {};
    try {
      const value = await profile().getProject(PACKAGE_NAME, PROJECT_KEY);
      if (value && typeof value === 'object') stored = value as Partial<Settings>;
    } catch (error) {
      console.warn(`[${PACKAGE_NAME}] read project settings failed`, error);
    }
    try {
      const value = await profile().getConfig(PACKAGE_NAME, GLOBAL_KEY, 'global');
      if (value && typeof value === 'object') keys = value as Record<string, string>;
    } catch (error) {
      console.warn(`[${PACKAGE_NAME}] read global api keys failed`, error);
    }

    this.settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...stored });
    this.apiKeys = sanitizeApiKeys(keys);
  }

  get(): Settings {
    return { ...this.settings };
  }

  getApiKeys(): Record<string, string> {
    return { ...this.apiKeys };
  }

  async update(patch: SettingsPatch): Promise<Settings> {
    const next = sanitizeSettings({ ...this.settings, ...patch });

    if (patch.apiKeys && typeof patch.apiKeys === 'object') {
      for (const [provider, rawValue] of Object.entries(patch.apiKeys)) {
        const key = String(rawValue ?? '').trim();
        if (!key) delete this.apiKeys[provider];
        else this.apiKeys[provider] = key;
      }
      await profile().setConfig(PACKAGE_NAME, GLOBAL_KEY, this.apiKeys, 'global');
    }

    this.settings = next;
    await profile().setProject(PACKAGE_NAME, PROJECT_KEY, next);
    return this.get();
  }

  getMaskedKeys(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [provider, key] of Object.entries(this.apiKeys)) {
      result[provider] = maskKey(key);
    }
    return result;
  }

  hasApiKey(provider: string): boolean {
    return Boolean(this.apiKeys[provider]?.trim());
  }

  getDTO(): SettingsDTO {
    return {
      settings: this.get(),
      maskedKeys: this.getMaskedKeys(),
      hasApiKey: Object.fromEntries(
        Object.keys(this.apiKeys).map((provider) => [provider, this.hasApiKey(provider)]),
      ),
    };
  }

  /** 注入到 pi 子进程的 provider 凭据；不要把 key 写进命令行。 */
  getProviderEnv(): Record<string, string> {
    const provider = this.settings.provider.trim();
    if (!provider) return {};
    const key = this.resolveApiKey(provider);
    if (!key) return {};
    return { [providerEnvName(provider)]: key };
  }

  resolveApiKey(provider: string): string | undefined {
    const direct = this.apiKeys[provider]?.trim();
    if (direct) return direct;
    const normalized = provider.toLowerCase();
    for (const [name, value] of Object.entries(this.apiKeys)) {
      if (name.toLowerCase() === normalized && value.trim()) return value.trim();
    }
    return undefined;
  }
}

function sanitizeSettings(value: Settings): Settings {
  return {
    provider: String(value.provider ?? '').trim(),
    model: String(value.model ?? '').trim(),
    thinking: THINKING_LEVELS.includes(value.thinking) ? value.thinking : 'default',
    piVersion: normalizeVersion(String(value.piVersion ?? '1.4.0')) || '1.4.0',
    piPath: String(value.piPath ?? '').trim(),
    piMirror: String(value.piMirror ?? '').trim(),
    autoStartAgent: Boolean(value.autoStartAgent),
    resumeLastSession: value.resumeLastSession !== false,
    maxTreeNodes: clampNumber(value.maxTreeNodes, 500, 20, 5000),
    language: value.language === 'en' ? 'en' : 'zh',
    theme: value.theme === 'dark' || value.theme === 'light' ? value.theme : 'auto',
    confirmMode: ['always', 'destructive', 'never'].includes(value.confirmMode)
      ? value.confirmMode
      : 'destructive',
    approvalWhenPanelClosed: value.approvalWhenPanelClosed === 'allow' ? 'allow' : 'deny',
  };
}

function sanitizeApiKeys(value: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [provider, key] of Object.entries(value ?? {})) {
    const name = String(provider ?? '').trim();
    const secret = String(key ?? '').trim();
    if (name && secret) result[name] = secret;
  }
  return result;
}

function normalizeVersion(value: string): string {
  const text = value.trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+/.test(text) ? text : '';
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function maskKey(key: string): string {
  const text = String(key ?? '');
  if (text.length <= 8) return text ? '********' : '';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function providerEnvName(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  const known: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_API_KEY',
    gemini: 'GOOGLE_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    groq: 'GROQ_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    xai: 'XAI_API_KEY',
    azure: 'AZURE_OPENAI_API_KEY',
    'azure-openai': 'AZURE_OPENAI_API_KEY',
    'github-copilot': 'GITHUB_COPILOT_API_KEY',
  };
  if (known[normalized]) return known[normalized];
  return `${normalized.replace(/[^a-z0-9]+/g, '_').toUpperCase()}_API_KEY`;
}
