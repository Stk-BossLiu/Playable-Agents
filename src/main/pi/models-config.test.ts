import { describe, expect, it } from 'vitest';
import { profileEnvName, profileProvider, providerFor } from './models-config';
import type { ModelProfile } from '../../shared/models';

const profile: ModelProfile = {
  id: 'deepseek-flash',
  name: 'DeepSeek Flash',
  baseUrl: 'https://api.deepseek.com',
  modelId: 'deepseek-chat',
  apiType: 'openai-completions',
  vision: false,
  contextWindow: 128000,
  maxTokens: 8192,
  reasoning: false,
};

describe('per-profile providers', () => {
  it('creates stable provider names with a prefix and hash', () => {
    const first = profileProvider('deepseek-flash');
    expect(first).toBe(profileProvider('deepseek-flash'));
    expect(first).toMatch(/^cocos-profile-deepseek-flash-[0-9a-f]{10}$/);
    expect(profileProvider('a.b')).not.toBe(profileProvider('a_b'));
  });

  it('creates unique env names per profile', () => {
    expect(profileEnvName('deepseek-flash')).toMatch(/^COCOS_AI_AGENT_MODEL_KEY_P_[0-9a-f]{10}$/);
    expect(profileEnvName('deepseek-flash')).not.toBe(profileEnvName('claude'));
  });

  it('writes an env-backed apiKey and vision input flags', () => {
    const provider = providerFor(profile, profileEnvName(profile.id), false) as {
      apiKey: string;
      models: Array<{ input: string[] }>;
    };
    expect(provider.apiKey).toBe(`$${profileEnvName(profile.id)}`);
    expect(provider.models[0].input).toEqual(['text']);
    const vision = providerFor({ ...profile, vision: true }, profileEnvName('v'), true) as {
      models: Array<{ input: string[] }>;
    };
    expect(vision.models[0].input).toEqual(['text', 'image']);
  });
});
