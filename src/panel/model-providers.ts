import type { ModelApiType, ModelProfileView } from '../shared/models';

export interface ProviderGroup {
  key: string;
  name: string;
  baseUrl: string;
  apiType: ModelApiType;
  profiles: ModelProfileView[];
}

export function groupModelProviders(profiles: ModelProfileView[]): ProviderGroup[] {
  const groups = new Map<string, ModelProfileView[]>();
  for (const profile of profiles) {
    // 同一个 baseURL 下可能配置了不同凭证的多个提供商，必须把 providerName 作为身份的一部分。
    const key = providerKey(
      profile.providerName ?? '',
      profile.baseUrl,
      profile.apiType,
    );
    const list = groups.get(key) ?? [];
    list.push(profile);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, profiles]) => ({
    key,
    name: providerDisplayName(profiles),
    baseUrl: profiles[0]?.baseUrl ?? '',
    apiType: (profiles[0]?.apiType ?? 'openai-completions') as ModelApiType,
    profiles,
  }));
}

export function providerKey(name: string, baseUrl: string, apiType: string): string {
  const trimmed = name.trim();
  return trimmed ? `${trimmed}||${baseUrl}||${apiType}` : `${baseUrl}||${apiType}`;
}

function profileProviderPrefix(profile: ModelProfileView): string {
  const suffix = profile.modelId ? ` · ${profile.modelId}` : '';
  return suffix && profile.name.endsWith(suffix)
    ? profile.name.slice(0, -suffix.length).trim()
    : '';
}

export function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname || value;
  } catch {
    return value;
  }
}

function providerDisplayName(profiles: ModelProfileView[]): string {
  const explicit = profiles.map((profile) => profile.providerName).find((name) => Boolean(name));
  if (explicit) return String(explicit);
  const prefixes = new Set(profiles.map(profileProviderPrefix).filter(Boolean));
  if (prefixes.size === 1) return [...prefixes][0];
  const baseUrl = profiles[0]?.baseUrl ?? '';
  try {
    return new URL(baseUrl).hostname || baseUrl || profiles[0]?.name || 'Provider';
  } catch {
    return baseUrl || profiles[0]?.name || 'Provider';
  }
}
