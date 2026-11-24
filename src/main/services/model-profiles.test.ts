import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelProfileStore } from './model-profiles';
import { ModelsConfigWriter } from '../pi/models-config';

describe('provider credential isolation', () => {
  const project = new Map<string, unknown>();
  const globalConfig = new Map<string, unknown>();
  const baseUrl = 'https://gateway.example.test';
  const create = (store: ModelProfileStore, name: string, modelId: string, secret: string) =>
    store.saveProviderModels({ name, baseUrl, secret, models: [{ modelId }] });

  beforeEach(() => {
    project.clear();
    globalConfig.clear();
    vi.stubGlobal('Editor', { Profile: {
      getProject: (_pkg: string, key: string) => structuredClone(project.get(key)),
      getConfig: (_pkg: string, key: string) => structuredClone(globalConfig.get(key)),
      setProject: (_pkg: string, key: string, value: unknown) => project.set(key, structuredClone(value)),
      setConfig: (_pkg: string, key: string, value: unknown) => globalConfig.set(key, structuredClone(value)),
    } });
    vi.spyOn(ModelsConfigWriter.prototype, 'write').mockResolvedValue('test-models.json');
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('keeps keys separate after creating two providers on the same gateway and reloading', async () => {
    const store = new ModelProfileStore();
    await store.init();
    await create(store, 'Company', 'gpt-model', 'test-key-a');
    await create(store, 'DeepSeek', 'deepseek-model', 'test-key-b');
    const restored = new ModelProfileStore();
    await restored.init();
    expect(restored.getSecret('gpt-model')).toBe('test-key-a');
    expect(restored.getSecret('deepseek-model')).toBe('test-key-b');
  });

  it('rejects an edit spanning two named providers before rewriting any credentials', async () => {
    const store = new ModelProfileStore();
    await store.init();
    await create(store, 'Company', 'gpt-model', 'test-key-a');
    await create(store, 'DeepSeek', 'deepseek-model', 'test-key-b');
    const ids = store.getProfiles().map(profile => profile.id);
    await expect(store.saveProviderModels({ name: 'Company', baseUrl, profileIds: ids,
      models: ids.map(id => ({ id, modelId: id })),
    })).rejects.toThrow();
    expect(store.getSecret('deepseek-model')).toBe('test-key-b');
    expect((globalConfig.get('modelSecrets') as Record<string, string>)['deepseek-model']).toBe('test-key-b');
  });
});
