<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { DependencyItem, DependenciesDTO } from '../shared/dependencies';
import type {
  AgentModelKind,
  ModelApiType,
  ModelProfileInput,
  ModelProfileView,
  ModelProfilesDTO,
} from '../shared/models';
import type { AgentStatus } from '../shared/types';
import { groupModelProviders, hostnameOf, providerKey, type ProviderGroup } from './model-providers';
import { request, requestRetry } from './api';
import { MessageName } from '../shared/protocol';
import { t } from './i18n';
import { setToast } from './store';
import ViewTabs from './components/ViewTabs.vue';
import ApprovalBar from './components/ApprovalBar.vue';

defineProps<{ embedded?: boolean }>();

const API_TYPES = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const;

const AGENT_MODEL_ITEMS = [
  { type: 'agent.llm', label: 'agentModel.llm' },
  { type: 'agent.structured', label: 'agentModel.structured' },
  { type: 'agent.role', label: 'agentModel.role' },
  { type: 'agent.role.pm', label: 'agentModel.rolePm' },
  { type: 'agent.role.designer', label: 'agentModel.roleDesigner' },
  { type: 'agent.role.developer', label: 'agentModel.roleDeveloper' },
  { type: 'agent.role.validator', label: 'agentModel.roleValidator' },
  { type: 'agent.playable-reverse', label: 'agentModel.playableReverse' },
  { type: 'agent.vision', label: 'agentModel.vision' },
] as const;

type ModalMode = 'provider' | 'model' | null;

const installingRea = ref(false);
const reaFeedback = ref('');
async function installRea(): Promise<void> {
  if (installingRea.value) return;
  installingRea.value = true;
  reaFeedback.value = '';
  try {
    await request<string>(MessageName.ReaInstall);
    reaFeedback.value = t('status.reaInstalled');
    await refresh();
  } catch (caught) {
    reaFeedback.value = errorText(caught);
  } finally {
    installingRea.value = false;
  }
}
const dependencies = ref<DependenciesDTO | null>(null);
const models = ref<ModelProfilesDTO | null>(null);
const agent = ref<AgentStatus>({ running: false });
const loading = ref(false);
const error = ref('');
const saving = ref(false);
const expandedProviders = ref<Record<string, boolean>>({});

const modalMode = ref<ModalMode>(null);
const editingModelId = ref<string | null>(null);
const activeGroupKey = ref<string | null>(null);

const providerForm = reactive({
  name: '',
  baseUrl: '',
  apiType: 'openai-completions' as ModelApiType,
  secret: '',
});

const modelForm = reactive({
  name: '',
  modelId: '',
  vision: false,
  reasoning: false,
  contextWindow: 128000,
  maxTokens: 8192,
});

interface DraftModel {
  id?: string;
  name: string;
  modelId: string;
  vision: boolean;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

const draftModels = ref<DraftModel[]>([]);
const loadingModels = ref(false);

const defaultProfile = computed(
  () => models.value?.profiles.find((profile) => profile.id === models.value?.defaultProfileId) ?? null,
);
const visionProfile = computed(
  () => models.value?.profiles.find((profile) => profile.id === models.value?.visionProfileId) ?? null,
);

onMounted(async () => {
  await refresh();
});

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [deps, modelData, agentStatus] = await Promise.all([
      requestRetry<DependenciesDTO>('dependencies-get'),
      requestRetry<ModelProfilesDTO>('model-profiles-get'),
      requestRetry<AgentStatus>('agent-status'),
    ]);
    dependencies.value = deps;
    models.value = modelData;
    agent.value = agentStatus;
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    loading.value = false;
  }
}

/* ---------- provider 分组 ---------- */

const providerGroups = computed(() => groupModelProviders(models.value?.profiles ?? []));

const activeGroup = computed(
  () => providerGroups.value.find((group) => group.key === activeGroupKey.value) ?? null,
);
const activeModel = computed(
  () => models.value?.profiles.find((profile) => profile.id === editingModelId.value) ?? null,
);
const modalTitle = computed(() => {
  if (modalMode.value === 'provider') {
    return activeGroupKey.value ? t('status.editProvider') : t('status.addProvider');
  }
  if (modalMode.value === 'model') return t('status.editModel');
  return '';
});
const providerProfileId = computed(() => activeGroup.value?.profiles[0]?.id ?? '');
const providerBaseUrl = computed(() => {
  if (modalMode.value === 'provider') return providerForm.baseUrl;
  return activeGroup.value?.baseUrl ?? activeModel.value?.baseUrl ?? '';
});

function isProviderOpen(key: string): boolean {
  return Boolean(expandedProviders.value[key]);
}

function toggleProvider(key: string): void {
  expandedProviders.value = {
    ...expandedProviders.value,
    [key]: !expandedProviders.value[key],
  };
}

function providerHasDefault(group: ProviderGroup): boolean {
  return group.profiles.some((profile) => profile.id === models.value?.defaultProfileId);
}

function providerHasVisionDefault(group: ProviderGroup): boolean {
  return group.profiles.some((profile) => profile.id === models.value?.visionProfileId);
}

/* ---------- 弹窗 ---------- */

function openProviderCreate(): void {
  modalMode.value = 'provider';
  editingModelId.value = null;
  activeGroupKey.value = null;
  providerForm.name = '';
  providerForm.baseUrl = '';
  providerForm.apiType = 'openai-completions';
  providerForm.secret = '';
  draftModels.value = [];
}

function openProviderEdit(group: ProviderGroup, autoFetch = false): void {
  modalMode.value = 'provider';
  editingModelId.value = null;
  activeGroupKey.value = group.key;
  providerForm.name = group.name;
  providerForm.baseUrl = group.baseUrl;
  providerForm.apiType = group.apiType;
  providerForm.secret = '';
  draftModels.value = group.profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    modelId: profile.modelId,
    vision: profile.vision,
    reasoning: profile.reasoning,
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxTokens,
  }));
  if (autoFetch) void fetchProviderModels();
}

function openModelEditor(profile: ModelProfileView): void {
  modalMode.value = 'model';
  editingModelId.value = profile.id;
  activeGroupKey.value =
    providerGroups.value.find((group) => group.profiles.some((item) => item.id === profile.id))?.key ?? null;
  modelForm.name = profile.name;
  modelForm.modelId = profile.modelId;
  modelForm.vision = profile.vision;
  modelForm.reasoning = profile.reasoning;
  modelForm.contextWindow = profile.contextWindow;
  modelForm.maxTokens = profile.maxTokens;
}

function closeModal(): void {
  modalMode.value = null;
  editingModelId.value = null;
  activeGroupKey.value = null;
  providerForm.secret = '';
  draftModels.value = [];
}

function addManualModel(): void {
  draftModels.value.push({
    name: '',
    modelId: '',
    vision: false,
    reasoning: false,
    contextWindow: 128000,
    maxTokens: 8192,
  });
}

function removeDraftModel(index: number): void {
  draftModels.value.splice(index, 1);
}

/* ---------- 获取模型列表 ---------- */

async function fetchModels(input: {
  baseUrl: string;
  apiType: ModelApiType;
  secret?: string;
  profileId?: string;
}): Promise<void> {
  if (loadingModels.value) return;
  const baseUrl = input.baseUrl.trim();
  if (!baseUrl) {
    setToast('warn', t('status.baseUrlRequired'));
    return;
  }
  loadingModels.value = true;
  try {
    const result = await request<{ ok: boolean; models: string[]; baseUrl?: string; error?: string }>(
      'model-list-models',
      {
        baseUrl,
        apiType: input.apiType,
        ...(input.secret ? { secret: input.secret } : {}),
        ...(input.profileId ? { profileId: input.profileId } : {}),
      },
    );
    if (!result.ok) {
      setToast('error', result.error ?? 'fetch models failed');
      return;
    }
    const known = new Set(
      draftModels.value.map((model) => model.modelId.trim()).filter(Boolean),
    );
    for (const modelId of result.models) {
      if (known.has(modelId)) continue;
      known.add(modelId);
      draftModels.value.push({
        name: '',
        modelId,
        vision: false,
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 8192,
      });
    }
    setToast(
      result.models.length ? 'success' : 'warn',
      result.models.length
        ? t('status.modelsFound', { count: result.models.length })
        : t('status.modelsEmpty'),
    );
  } catch (caught) {
    error.value = errorText(caught);
    setToast('error', errorText(caught));
  } finally {
    loadingModels.value = false;
  }
}

async function fetchProviderModels(): Promise<void> {
  const secret = providerForm.secret.trim();
  if (!providerForm.baseUrl.trim()) {
    setToast('warn', t('status.baseUrlRequired'));
    return;
  }
  if (!secret && !providerProfileId.value) {
    setToast('warn', t('status.secretRequired'));
    return;
  }
  await fetchModels({
    baseUrl: providerForm.baseUrl,
    apiType: providerForm.apiType,
    ...(secret ? { secret } : {}),
    ...(!secret && providerProfileId.value ? { profileId: providerProfileId.value } : {}),
  });
}

function autoFetchProvider(): void {
  if (!draftModels.value.length && !loadingModels.value) void fetchProviderModels();
}

/* ---------- 保存提供商 ---------- */

async function saveProvider(): Promise<void> {
  if (!providerForm.baseUrl.trim()) {
    setToast('warn', t('status.baseUrlRequired'));
    return;
  }
  const drafts = draftModels.value.filter((model) => model.modelId.trim());
  if (!drafts.length) {
    setToast('warn', t('status.selectModelsFirst'));
    return;
  }
  if (!providerForm.secret.trim() && !activeGroup.value) {
    setToast('warn', t('status.secretRequired'));
    return;
  }
  saving.value = true;
  try {
    const baseUrl = providerForm.baseUrl.trim();
    const dto = await request<ModelProfilesDTO>('model-provider-save', {
      profileIds: activeGroup.value?.profiles.map((profile) => profile.id) ?? [],
      name: providerForm.name.trim(),
      baseUrl,
      apiType: providerForm.apiType,
      ...(providerForm.secret.trim() ? { secret: providerForm.secret.trim() } : {}),
      models: drafts.map((model) => ({
        ...(model.id ? { id: model.id } : {}),
        name: model.name.trim(),
        modelId: model.modelId.trim(),
        vision: model.vision,
        reasoning: model.reasoning,
        contextWindow: Number(model.contextWindow),
        maxTokens: Number(model.maxTokens),
      })),
    });
    models.value = dto;
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
    const providerName =
      providerForm.name.trim() || activeGroup.value?.name || hostnameOf(normalizedBaseUrl);
    expandedProviders.value = {
      ...expandedProviders.value,
      [providerKey(providerName, normalizedBaseUrl, providerForm.apiType)]: true,
    };
    setToast('success', t('status.providerSaved'));
    closeModal();
  } catch (caught) {
    error.value = errorText(caught);
    setToast('error', errorText(caught));
  } finally {
    saving.value = false;
  }
}

async function deleteProvider(): Promise<void> {
  const group = activeGroup.value;
  if (!group) return;
  if (!window.confirm(t('status.deleteProviderConfirm', { name: group.name }))) return;
  saving.value = true;
  try {
    models.value = await request<ModelProfilesDTO>('model-provider-delete', {
      profileIds: group.profiles.map((profile) => profile.id),
    });
    setToast('info', group.name);
    closeModal();
  } catch (caught) {
    error.value = errorText(caught);
    setToast('error', errorText(caught));
  } finally {
    saving.value = false;
  }
}

/* ---------- 编辑单个模型 ---------- */

async function persistModel(): Promise<boolean> {
  if (!editingModelId.value) return false;
  if (!modelForm.modelId.trim()) {
    setToast('warn', t('status.modelIdRequired'));
    return false;
  }
  saving.value = true;
  try {
    const input: ModelProfileInput = {
      id: editingModelId.value,
      name: modelForm.name.trim() || modelForm.modelId.trim(),
      modelId: modelForm.modelId.trim(),
      vision: modelForm.vision,
      reasoning: modelForm.reasoning,
      contextWindow: Number(modelForm.contextWindow),
      maxTokens: Number(modelForm.maxTokens),
    };
    await request<ModelProfileView>('model-profile-save', input);
    await refresh();
    return true;
  } catch (caught) {
    error.value = errorText(caught);
    setToast('error', errorText(caught));
    return false;
  } finally {
    saving.value = false;
  }
}

async function saveModelEditor(apply: boolean): Promise<void> {
  if (!(await persistModel())) return;
  if (apply) {
    await applyModels();
  } else {
    setToast('success', t('status.modelSaved'));
  }
  closeModal();
}

async function validateEditingModel(): Promise<void> {
  if (!editingModelId.value) return;
  if (!(await persistModel())) return;
  try {
    const result = await request<{
      profile: ModelProfileView;
      validation: { ok: boolean; latencyMs?: number; error?: string; models?: string[] };
    }>('model-profile-validate', { id: editingModelId.value });
    setToast(
      result.validation.ok ? 'success' : 'error',
      result.validation.ok
        ? t('status.validationOk', { ms: result.validation.latencyMs ?? 0 })
        : result.validation.error ?? 'validate failed',
    );
    await refresh();
  } catch (caught) {
    error.value = errorText(caught);
    setToast('error', errorText(caught));
  }
}

async function deleteEditingModel(): Promise<void> {
  const profile = activeModel.value;
  if (!profile) return;
  saving.value = true;
  try {
    await request('model-profile-delete', { id: profile.id });
    await refresh();
    setToast('info', profile.name);
    closeModal();
  } catch (caught) {
    error.value = errorText(caught);
    setToast('error', errorText(caught));
  } finally {
    saving.value = false;
  }
}

/* ---------- 默认模型 / 节点 Agent 模型 ---------- */

async function applyModels(): Promise<void> {
  try {
    const result = await request<{ path: string; restarted?: boolean; restartError?: string }>('model-profile-apply');
    await refresh();
    if (result.restartError) {
      setToast('warn', result.restartError);
    } else {
      setToast('success', `${t('status.applyDone')}: ${result.path}`);
    }
  } catch (caught) {
    error.value = errorText(caught);
    setToast('error', errorText(caught));
  }
}

async function setDefault(kind: 'default' | 'vision', value: string): Promise<void> {
  try {
    models.value = await request<ModelProfilesDTO>('model-defaults-set', {
      ...(kind === 'default' ? { defaultProfileId: value || null } : { visionProfileId: value || null }),
    });
  } catch (caught) {
    error.value = errorText(caught);
  }
}

async function setAgentModel(kind: AgentModelKind, value: string): Promise<void> {
  try {
    models.value = await request<ModelProfilesDTO>('model-defaults-set', {
      agentProfiles: { ...(models.value?.agentProfiles ?? {}), [kind]: value || null },
    });
    setToast('success', t('status.agentModelSaved'));
  } catch (caught) {
    error.value = errorText(caught);
    setToast('error', errorText(caught));
  }
}

function agentFallbackLabel(type: AgentModelKind): string {
  if (type === 'agent.vision') return t('status.followVisionDefault');
  if (type.startsWith('agent.role.')) return t('status.followRoleDefault');
  return t('status.followDefault');
}

/** 视觉类节点只能选择勾选了“支持图片输入”的 profile。 */
function profilesForAgent(kind: AgentModelKind): ModelProfileView[] {
  const list = models.value?.profiles ?? [];
  return kind === 'agent.vision' ? list.filter((profile) => profile.vision) : list;
}

/* ---------- 依赖状态 ---------- */

function stateLabel(value: DependencyItem['state']): string {
  return t(`state.${value}` as never);
}

function statusClass(value: DependencyItem['state']): string {
  if (value === 'ready') return 'ok';
  if (value === 'missing' || value === 'error') return 'bad';
  if (value === 'not-required' || value === 'optional') return 'muted';
  return 'warn';
}

function errorText(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  if (typeof caught === 'string') return caught;
  return String(caught);
}
</script>

<template>
  <div class="shell status-shell">
    <header v-if="!embedded" class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">◆</span>
        <span class="brand-title">{{ t('brand.title') }}</span>
        <span class="phase-pill">Phase 4</span>
      </div>
      <div class="topbar-actions">
        <ViewTabs active="status" />
        <button type="button" class="icon-btn" :title="t('status.refresh')" @click="refresh">↻</button>
      </div>
    </header>

    <ApprovalBar />

    <main class="status-main">
      <p v-if="error" class="error-line">{{ error }}</p>

      <section class="status-section">
        <div class="side-head">
          <h2>{{ t('status.dependencies') }}</h2>
          <div class="topbar-actions">
            <span v-if="dependencies" class="muted">{{ new Date(dependencies.checkedAt).toLocaleTimeString() }}</span>
            <button type="button" class="link-btn" :disabled="loading" @click="refresh">
              {{ t(loading ? 'status.checking' : 'status.recheck') }}
            </button>
          </div>
        </div>
        <div class="dependency-list">
          <div v-for="item in dependencies?.items ?? []" :key="item.id" class="dependency-row">
            <span class="status-dot" :class="statusClass(item.state)"></span>
            <div class="dependency-main">
              <div class="dependency-title">
                <strong>{{ item.label }}</strong>
                <span v-if="item.version" class="tag">{{ item.version }}</span>
                <span v-if="!item.required" class="tag muted">{{ t('status.optional') }}</span>
              </div>
              <div v-if="item.path" class="dependency-path">{{ item.path }}</div>
              <div v-if="item.message" class="dependency-message">{{ item.message }}</div>
              <template v-if="item.id === 'rea'">
                <button v-if="item.state === 'missing'" type="button" class="btn" :disabled="installingRea" @click="installRea">
                  {{ t(installingRea ? 'status.reaInstalling' : 'status.installRea') }}
                </button>
                <p v-if="reaFeedback" role="status" class="dependency-message">{{ reaFeedback }}</p>
              </template>
              <div v-if="item.action" class="dependency-action">{{ t('status.suggestion', { action: item.action }) }}</div>
            </div>
            <span class="dependency-state" :class="statusClass(item.state)">{{ stateLabel(item.state) }}</span>
          </div>
        </div>
      </section>

      <section class="status-section">
        <div class="side-head">
          <h2>{{ t('status.models') }}</h2>
          <button type="button" class="link-btn" @click="openProviderCreate">＋ {{ t('status.addProvider') }}</button>
        </div>
        <div class="model-defaults">
          <label class="field compact">
            <span>{{ t('status.default') }}</span>
            <select :value="models?.defaultProfileId ?? ''" @change="setDefault('default', ($event.target as HTMLSelectElement).value)">
              <option value="">{{ t('status.notConfigured') }}</option>
              <option v-for="profile in models?.profiles ?? []" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
            </select>
          </label>
          <label class="field compact">
            <span>{{ t('status.visionProfile') }}</span>
            <select :value="models?.visionProfileId ?? ''" @change="setDefault('vision', ($event.target as HTMLSelectElement).value)">
              <option value="">{{ t('status.notConfigured') }}</option>
              <option v-for="profile in models?.profiles ?? []" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
            </select>
          </label>
        </div>

        <h3 class="model-subtitle">{{ t('status.agentModels') }}</h3>
        <p class="muted models-path">{{ t('status.agentModelHint') }}</p>
        <div class="model-defaults">
          <label v-for="item in AGENT_MODEL_ITEMS" :key="item.type" class="field compact">
            <span>{{ t(item.label) }}</span>
            <select
              :value="models?.agentProfiles?.[item.type] ?? ''"
              @change="setAgentModel(item.type, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">{{ agentFallbackLabel(item.type) }}</option>
              <option v-for="profile in profilesForAgent(item.type)" :key="profile.id" :value="profile.id">
                {{ profile.name }}
              </option>
            </select>
          </label>
        </div>

        <p class="muted models-path">{{ models?.piModelsPath }}</p>

        <div v-if="!models?.profiles.length" class="empty-line">{{ t('status.noModels') }}</div>
        <div v-else class="provider-groups">
          <section v-for="group in providerGroups" :key="group.key" class="provider-group">
            <div
              class="provider-head"
              :class="{ open: isProviderOpen(group.key) }"
              role="button"
              tabindex="0"
              @click="toggleProvider(group.key)"
              @keydown.enter="toggleProvider(group.key)"
            >
              <span class="provider-caret" aria-hidden="true">▸</span>
              <strong class="provider-name">{{ group.name }}</strong>
              <span class="provider-meta">{{ t('status.modelCount', { count: group.profiles.length }) }}</span>
              <span class="provider-meta">{{ group.apiType }}</span>
              <span class="provider-tags">
                <span v-if="providerHasDefault(group)" class="tag accent">{{ t('status.default') }}</span>
                <span v-if="providerHasVisionDefault(group)" class="tag">{{ t('status.visionProfile') }}</span>
              </span>
              <span class="provider-actions">
                <button
                  type="button"
                  class="link-btn provider-edit"
                  :title="t('status.editProvider')"
                  @click.stop="openProviderEdit(group)"
                >
                  ✎
                </button>
                <button
                  type="button"
                  class="link-btn provider-add"
                  :title="t('status.addModel')"
                  @click.stop="openProviderEdit(group, true)"
                >
                  ＋
                </button>
              </span>
            </div>
            <div v-if="isProviderOpen(group.key)" class="provider-models">
              <button
                v-for="profile in group.profiles"
                :key="profile.id"
                type="button"
                class="profile-row"
                :class="{ active: modalMode === 'model' && editingModelId === profile.id }"
                @click="openModelEditor(profile)"
              >
                <div>
                  <strong>{{ profile.name }}</strong>
                  <span class="profile-id">{{ profile.modelId }}</span>
                </div>
                <div class="profile-badges">
                  <span v-if="profile.id === models.defaultProfileId" class="tag accent">{{ t('status.default') }}</span>
                  <span v-if="profile.id === models.visionProfileId" class="tag">{{ t('status.visionProfile') }}</span>
                  <span v-if="profile.lastValidation?.ok" class="tag ok">{{ t('status.validationOk', { ms: profile.lastValidation.latencyMs ?? 0 }) }}</span>
                  <span v-if="profile.lastValidation && !profile.lastValidation.ok" class="tag bad">{{ t('status.validationFailed') }}</span>
                  <span class="status-dot" :class="profile.secretConfigured ? 'ok' : 'bad'"></span>
                </div>
              </button>
            </div>
          </section>
        </div>

      </section>

      <section class="status-section">
        <div class="side-head">
          <h2>{{ t('status.pi') }}</h2>
        </div>
        <div class="process-grid">
          <div><span class="muted">{{ t('status.agent') }}</span><strong>{{ agent.running ? t('status.running') : t('status.stopped') }}</strong></div>
          <div><span class="muted">{{ t('status.pid') }}</span><strong>{{ agent.pid ?? '—' }}</strong></div>
          <div><span class="muted">{{ t('status.model') }}</span><strong>{{ agent.model ?? '—' }}</strong></div>
          <div><span class="muted">{{ t('status.bridge') }}</span><strong>{{ agent.bridgeUrl ?? '—' }}</strong></div>
        </div>
      </section>
    </main>

    <div v-if="modalMode" class="model-modal-backdrop" @click.self="closeModal">
      <section class="model-modal" role="dialog" aria-modal="true">
        <div class="model-modal-head">
          <h3>{{ modalTitle }}</h3>
          <button type="button" class="link-btn" :title="t('settings.close')" @click="closeModal">×</button>
        </div>

        <!-- 提供商：凭证 + 模型列表；模型的四项参数只在这里逐行或单模型弹窗里配置 -->
        <form v-if="modalMode === 'provider'" class="model-form modal-form" @submit.prevent="saveProvider">
          <div class="form-grid">
            <label class="field">
              <span>{{ t('status.providerName') }}</span>
              <input v-model="providerForm.name" placeholder="deepseek / OpenAI" />
            </label>
            <label class="field">
              <span>{{ t('status.apiType') }}</span>
              <select v-model="providerForm.apiType">
                <option v-for="type in API_TYPES" :key="type" :value="type">{{ type }}</option>
              </select>
            </label>
          </div>
          <label class="field">
            <span>{{ t('status.baseUrl') }}</span>
            <input v-model="providerForm.baseUrl" placeholder="https://api.example.com/v1" @blur="autoFetchProvider" />
          </label>
          <label class="field">
            <span>{{ t('status.secret') }}</span>
            <input
              v-model="providerForm.secret"
              type="password"
              autocomplete="off"
              :placeholder="activeGroupKey ? t('status.secretKeep') : t('status.secretPlaceholder')"
              @blur="autoFetchProvider"
            />
          </label>

          <div class="provider-draft-head">
            <strong>{{ t('status.modelList') }}</strong>
            <div class="model-picker-actions">
              <button type="button" class="btn" :disabled="loadingModels" @click="fetchProviderModels">
                {{ loadingModels ? t('status.fetchingModels') : t('status.fetchModels') }}
              </button>
              <button type="button" class="btn" :disabled="saving" @click="addManualModel">
                {{ t('status.manualAdd') }}
              </button>
            </div>
          </div>
          <p class="muted">{{ t('status.providerHint') }}</p>

          <div class="draft-models">
            <div class="draft-row draft-head">
              <span>{{ t('status.modelDisplayName') }}</span>
              <span>{{ t('status.actualModel') }}</span>
              <span>{{ t('status.contextWindow') }}</span>
              <span>{{ t('status.maxTokens') }}</span>
              <span>{{ t('status.visionShort') }}</span>
              <span>{{ t('status.reasoningShort') }}</span>
              <span></span>
            </div>
            <div v-for="(model, index) in draftModels" :key="index" class="draft-row">
              <input v-model="model.name" :placeholder="t('status.modelDisplayName')" />
              <input v-model="model.modelId" placeholder="model-id" />
              <input v-model.number="model.contextWindow" type="number" min="1000" max="4000000" />
              <input v-model.number="model.maxTokens" type="number" min="1" max="1000000" />
              <label class="draft-check"><input v-model="model.vision" type="checkbox" /></label>
              <label class="draft-check"><input v-model="model.reasoning" type="checkbox" /></label>
              <button type="button" class="link-btn" :title="t('status.delete')" @click="removeDraftModel(index)">×</button>
            </div>
            <div v-if="!draftModels.length" class="empty-line">{{ t('status.modelsEmpty') }}</div>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn primary" :disabled="saving || !draftModels.length">
              {{ t('status.save') }}
            </button>
            <button v-if="activeGroupKey" type="button" class="btn danger" :disabled="saving" @click="deleteProvider">
              {{ t('status.deleteProvider') }}
            </button>
            <button type="button" class="btn ghost" :disabled="saving" @click="closeModal">
              {{ t('status.cancel') }}
            </button>
          </div>
        </form>

        <!-- 单个模型：名称、图片输入、推理模型等模型级能力 -->
        <form v-else class="model-form modal-form" @submit.prevent="saveModelEditor(false)">
          <p class="muted">{{ activeGroup?.name }} · {{ providerBaseUrl }}</p>
          <div class="form-grid">
            <label class="field">
              <span>{{ t('status.name') }}</span>
              <input v-model="modelForm.name" placeholder="DeepSeek Flash" />
            </label>
            <label class="field">
              <span>{{ t('status.modelId') }}</span>
              <input v-model="modelForm.modelId" placeholder="deepseek-chat" />
            </label>
          </div>
          <div class="form-grid">
            <label class="field">
              <span>{{ t('status.contextWindow') }}</span>
              <input v-model.number="modelForm.contextWindow" type="number" min="1000" max="4000000" />
            </label>
            <label class="field">
              <span>{{ t('status.maxTokens') }}</span>
              <input v-model.number="modelForm.maxTokens" type="number" min="1" max="1000000" />
            </label>
          </div>
          <div class="check-row">
            <label><input v-model="modelForm.vision" type="checkbox" /> {{ t('status.vision') }}</label>
            <label><input v-model="modelForm.reasoning" type="checkbox" /> {{ t('status.reasoning') }}</label>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn primary" :disabled="saving">{{ t('status.apply') }}</button>
            <button type="button" class="btn" :disabled="saving" @click="saveModelEditor(false)">
              {{ t('status.save') }}
            </button>
            <button type="button" class="btn" :disabled="saving" @click="validateEditingModel">
              {{ t('status.validate') }}
            </button>
            <button type="button" class="btn danger" :disabled="saving" @click="deleteEditingModel">
              {{ t('status.deleteModel') }}
            </button>
            <button type="button" class="btn ghost" :disabled="saving" @click="closeModal">
              {{ t('status.cancel') }}
            </button>
          </div>
        </form>
      </section>
    </div>
  </div>
</template>

