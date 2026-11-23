import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelProfile } from '../../shared/models';
import { ModelsConfigWriter, DEFAULT_MODEL_ENV, profileEnvName, profileProvider } from '../pi/models-config';
import { fetchAvailableModels, validateModelEndpoint } from './model-validation';

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'test',
    name: 'Test Model',
    baseUrl: 'http://127.0.0.1:1/v1',
    modelId: 'test-model',
    apiType: 'openai-completions',
    vision: false,
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: false,
    ...overrides,
  };
}

async function endpoint(options: { models?: string[]; chat?: boolean; unauthorized?: boolean }): Promise<string> {
  const server = createServer((req, res) => {
    if (options.unauthorized) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (req.url?.endsWith('/models')) {
      if (!options.models) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: options.models.map((id) => ({ id })) }));
      return;
    }
    if (req.url?.endsWith('/chat/completions') && options.chat) {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [] }));
      return;
    }
    res.writeHead(404).end('not found');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  return `http://127.0.0.1:${address.port}`;
}

describe('validateModelEndpoint', () => {
  it('accepts a model found in GET /models', async () => {
    const base = await endpoint({ models: ['test-model'] });
    const result = await validateModelEndpoint(profile({ baseUrl: `${base}/v1` }), 'sk-test');
    expect(result.ok).toBe(true);
    expect(result.models).toContain('test-model');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('warns when the model is not listed but the endpoint responds', async () => {
    const base = await endpoint({ models: ['other-model'] });
    const result = await validateModelEndpoint(profile({ baseUrl: `${base}/v1` }), 'sk-test');
    expect(result.ok).toBe(true);
    expect(result.warning).toContain('未找到');
  });

  it('falls back to chat completions when /models is unavailable', async () => {
    const base = await endpoint({ chat: true });
    const result = await validateModelEndpoint(profile({ baseUrl: `${base}/v1` }), 'sk-test');
    expect(result.ok).toBe(true);
  });

  it('reports auth failures without leaking the secret', async () => {
    const base = await endpoint({ unauthorized: true });
    const result = await validateModelEndpoint(profile({ baseUrl: `${base}/v1` }), 'sk-super-secret');
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('sk-super-secret');
  });
});

describe('fetchAvailableModels', () => {
  it('lists models without requiring a modelId and deduplicates them', async () => {
    const base = await endpoint({ models: ['alpha', 'beta', 'alpha'] });
    const result = await fetchAvailableModels(`${base}/v1`, 'sk-test');
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['alpha', 'beta']);
    expect(result.baseUrl).toBe(`${base}/v1`);
  });

  it('reports failures without leaking the secret', async () => {
    const base = await endpoint({ unauthorized: true });
    const result = await fetchAvailableModels(`${base}/v1`, 'sk-super-secret');
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('sk-super-secret');
  });
});

describe('ModelsConfigWriter', () => {
  it('writes env references and preserves other providers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cocos-agent-models-'));
    dirs.push(dir);
    const writer = new ModelsConfigWriter(dir);
    writeFileSync(
      writer.configPath,
      JSON.stringify({ providers: { other: { baseUrl: 'https://example.com', models: [] } } }, null, 2),
      'utf8',
    );
    const model = profile();
    await writer.write({ default: model });
    const parsed = JSON.parse(readFileSync(writer.configPath, 'utf8'));
    expect(parsed.providers.other).toBeTruthy();
    expect(parsed.providers['cocos-default'].apiKey).toBe(`$${DEFAULT_MODEL_ENV}`);
    expect(JSON.stringify(parsed)).not.toContain('sk-test');
  });

  it('writes one switchable provider per profile for agent nodes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cocos-agent-models-'));
    dirs.push(dir);
    const writer = new ModelsConfigWriter(dir);
    const alpha = profile({ id: 'alpha', modelId: 'alpha-model' });
    const beta = profile({ id: 'beta', modelId: 'beta-model', vision: true });
    await writer.write({ all: [alpha, beta] });
    const parsed = JSON.parse(readFileSync(writer.configPath, 'utf8'));
    const alphaProvider = parsed.providers[profileProvider('alpha')];
    expect(alphaProvider).toBeTruthy();
    expect(alphaProvider.apiKey).toBe(`$${profileEnvName('alpha')}`);
    expect(alphaProvider.models[0].id).toBe('alpha-model');
    const betaProvider = parsed.providers[profileProvider('beta')];
    expect(betaProvider.models[0].input).toEqual(['text', 'image']);
    expect(JSON.stringify(parsed)).not.toContain('sk-test');
  });
});
