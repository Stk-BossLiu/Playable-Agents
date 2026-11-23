<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { t } from '../i18n';
import type {
  PiBinaryInfo,
  PiDownloadProgress,
  Settings,
  SettingsPatch,
  ThinkingSetting,
} from '../../shared/types';

const props = defineProps<{
  settings: Settings;
  maskedKeys: Record<string, string>;
  hasApiKey: Record<string, boolean>;
  binary: PiBinaryInfo | null;
  download: PiDownloadProgress | null;
}>();

const emit = defineEmits<{
  close: [];
  save: [patch: SettingsPatch];
  download: [];
  selectPath: [];
}>();

const form = reactive({
  provider: props.settings.provider,
  model: props.settings.model,
  thinking: props.settings.thinking as ThinkingSetting,
  piVersion: props.settings.piVersion,
  piMirror: props.settings.piMirror,
  autoStartAgent: props.settings.autoStartAgent,
  resumeLastSession: props.settings.resumeLastSession,
  confirmMode: props.settings.confirmMode,
  approvalWhenPanelClosed: props.settings.approvalWhenPanelClosed,
});

const apiKey = ref('');

watch(
  () => props.settings,
  (value) => {
    form.provider = value.provider;
    form.model = value.model;
    form.thinking = value.thinking;
    form.piVersion = value.piVersion;
    form.piMirror = value.piMirror;
    form.autoStartAgent = value.autoStartAgent;
    form.resumeLastSession = value.resumeLastSession;
    form.confirmMode = value.confirmMode;
    form.approvalWhenPanelClosed = value.approvalWhenPanelClosed;
  },
  { deep: true },
);

const providers = [
  { value: '', label: '' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'groq', label: 'Groq' },
  { value: 'xai', label: 'xAI' },
  { value: 'custom', label: 'Custom' },
];

const thinkingLevels: ThinkingSetting[] = ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const keyPlaceholder = computed(() => {
  if (form.provider && props.hasApiKey[form.provider]) {
    return t('settings.apiKeySaved', { masked: props.maskedKeys[form.provider] ?? '****' });
  }
  return t('settings.apiKeyPlaceholder');
});

const binaryLabel = computed(() => {
  if (!props.binary) return t('settings.binaryMissing');
  const sourceKeys = {
    custom: 'settings.binarySource.custom',
    downloaded: 'settings.binarySource.downloaded',
    path: 'settings.binarySource.path',
  } as const;
  const source = t(sourceKeys[props.binary.source]);
  return `${source} · ${props.binary.version}`;
});

const downloadBusy = computed(() => {
  const phase = props.download?.phase;
  return phase === 'resolving' || phase === 'downloading' || phase === 'verifying' || phase === 'extracting';
});

function save(): void {
  const patch: SettingsPatch = {
    provider: form.provider,
    model: form.model,
    thinking: form.thinking,
    piVersion: form.piVersion,
    piMirror: form.piMirror,
    autoStartAgent: form.autoStartAgent,
    resumeLastSession: form.resumeLastSession,
    confirmMode: form.confirmMode,
    approvalWhenPanelClosed: form.approvalWhenPanelClosed,
  };
  const key = apiKey.value.trim();
  if (form.provider && key) {
    patch.apiKeys = { [form.provider]: key };
  }
  apiKey.value = '';
  emit('save', patch);
}
</script>

<template>
  <div class="drawer-backdrop" @click.self="emit('close')">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ t('settings.title') }}</h2>
        <button type="button" class="icon-btn" :aria-label="t('settings.close')" @click="emit('close')">×</button>
      </header>

      <div class="drawer-body">
        <section class="drawer-section">
          <h3>{{ t('settings.model') }}</h3>

          <label class="field">
            <span>{{ t('settings.provider') }}</span>
            <select v-model="form.provider">
              <option v-for="provider in providers" :key="provider.value" :value="provider.value">
                {{ provider.value ? provider.label : t('settings.providerPlaceholder') }}
              </option>
            </select>
          </label>

          <label class="field">
            <span>{{ t('settings.modelId') }}</span>
            <input v-model="form.model" type="text" :placeholder="t('settings.modelPlaceholder')" />
          </label>

          <label class="field">
            <span>{{ t('settings.apiKey') }}</span>
            <input v-model="apiKey" type="password" :placeholder="keyPlaceholder" autocomplete="off" />
          </label>

          <label class="field">
            <span>{{ t('settings.thinking') }}</span>
            <select v-model="form.thinking">
              <option v-for="level in thinkingLevels" :key="level" :value="level">{{ level }}</option>
            </select>
          </label>
        </section>

        <section class="drawer-section">
          <h3>{{ t('settings.piBinary') }}</h3>
          <div class="binary-status">
            <span :class="binary ? 'ok' : 'pending'">●</span>
            <span>{{ binaryLabel }}</span>
          </div>
          <p v-if="binary" class="path-line">{{ binary.path }}</p>

          <div class="field-row">
            <label class="field compact">
              <span>{{ t('settings.piVersion') }}</span>
              <input v-model="form.piVersion" type="text" placeholder="1.4.0" />
            </label>
            <label class="field compact">
              <span>{{ t('settings.piMirror') }}</span>
              <input v-model="form.piMirror" type="text" :placeholder="t('settings.piMirrorPlaceholder')" />
            </label>
          </div>

          <div class="button-row">
            <button type="button" class="btn primary" :disabled="downloadBusy" @click="emit('download')">
              {{ downloadBusy ? t('settings.downloading') : t('settings.download') }}
            </button>
            <button type="button" class="btn" @click="emit('selectPath')">{{ t('settings.selectPath') }}</button>
          </div>

          <div v-if="download" class="download-line">
            <div class="progress-track">
              <div class="progress-fill" :style="{ width: `${download.percent}%` }"></div>
            </div>
            <span>
              {{ download.phase === 'done' ? t('settings.downloadDone') : download.phase === 'error' ? t('settings.downloadFailed') : download.phase }}
              {{ download.percent ? `${download.percent}%` : '' }}
            </span>
          </div>
        </section>

        <section class="drawer-section">
          <h3>{{ t('settings.behavior') }}</h3>
          <label class="check-row">
            <input v-model="form.autoStartAgent" type="checkbox" />
            <span>{{ t('settings.autoStart') }}</span>
          </label>
          <label class="check-row">
            <input v-model="form.resumeLastSession" type="checkbox" />
            <span>{{ t('settings.resume') }}</span>
          </label>
        </section>

        <section class="drawer-section">
          <h3>{{ t('settings.security') }}</h3>
          <label class="field">
            <span>{{ t('settings.confirmMode') }}</span>
            <select v-model="form.confirmMode">
              <option value="destructive">{{ t('settings.confirmDestructive') }}</option>
              <option value="always">{{ t('settings.confirmAlways') }}</option>
              <option value="never">{{ t('settings.confirmNever') }}</option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('settings.approvalClosed') }}</span>
            <select v-model="form.approvalWhenPanelClosed">
              <option value="deny">{{ t('settings.approvalDeny') }}</option>
              <option value="allow">{{ t('settings.approvalAllow') }}</option>
            </select>
          </label>
        </section>
      </div>

      <footer class="drawer-foot">
        <button type="button" class="btn" @click="emit('close')">{{ t('settings.close') }}</button>
        <button type="button" class="btn primary" @click="save">{{ t('settings.save') }}</button>
      </footer>
    </aside>
  </div>
</template>
