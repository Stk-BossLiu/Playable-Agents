<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { t } from './i18n';
import { request, requestRetry } from './api';
import { MessageName } from '../shared/protocol';
import type {
  AgentSessionSummary,
  AgentStatus,
  AppInfo,
  PromptResponse,
  SettingsGetResponse,
  SettingsPatch,
  ThinkingLevel,
} from '../shared/types';
import type { ModelProfileView, ModelProfilesDTO } from '../shared/models';
import {
  addUserMessage,
  clearError,
  hydrateMessages,
  resetMessages,
  setError,
  setToast,
  state,
  type ChatMessage,
} from './store';
import ToolCard from './components/ToolCard.vue';
import SettingsDrawer from './components/SettingsDrawer.vue';
import ViewTabs from './components/ViewTabs.vue';

defineProps<{ embedded?: boolean }>();

const input = ref('');
const messagesEl = ref<HTMLElement | null>(null);
const starting = ref(false);
const alwaysApprove = ref(false);
const thinkingLevel = ref<ThinkingLevel>('off');
const thinkingLevels = ref<ThinkingLevel[]>([]);
const preferredThinking = ref<ThinkingLevel>('off');
const loadingThinking = ref(false);
const modelProfiles = ref<ModelProfileView[]>([]);
const selectedModelKey = ref('');
const switchingModel = ref(false);
const sessions = ref<AgentSessionSummary[]>([]);
const sessionsError = ref('');

const canSend = computed(() => input.value.trim().length > 0 && !state.sending);
const streamingMessage = computed(
  () =>
    [...state.messages].reverse().find((message) => message.role === 'assistant' && message.streaming) ??
    null,
);
/** Agent 已开始但还没有任何文字/思考/工具输出时，显示等待动画。 */
const waitingForReply = computed(() => {
  if (state.error) return false;
  const message = streamingMessage.value;
  if (message) {
    return !message.error && !message.text && !message.thinking && !message.toolCalls.length;
  }
  return state.running;
});
const waitingSeconds = ref(0);
let waitingTimer: ReturnType<typeof setInterval> | null = null;
watch(
  waitingForReply,
  (active) => {
    if (waitingTimer) {
      clearInterval(waitingTimer);
      waitingTimer = null;
    }
    waitingSeconds.value = 0;
    if (active) {
      waitingTimer = setInterval(() => {
        waitingSeconds.value += 1;
      }, 1000);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (waitingTimer) clearInterval(waitingTimer);
  waitingTimer = null;
});
const bridgeReady = computed(() => Boolean(state.agent.bridgeUrl));
const editorLabel = computed(() => state.appInfo?.editorVersion ?? t('status.unknown'));
const footerName = computed(() =>
  state.appInfo ? `${state.appInfo.name} v${state.appInfo.version}` : 'cocos-ai-agent',
);
const binaryLabel = computed(() => {
  if (!state.binary) return t('settings.binaryMissing');
  return `${state.binary.source} · ${state.binary.version}`;
});
const agentLabel = computed(() => (state.agent.running ? t('status.running') : t('status.stopped')));
const telemetry = computed(() => {
  const items: string[] = [];
  const scene = state.editorContext.scene;
  if (scene) items.push(`${scene.name ?? scene.uuid ?? '场景'}${scene.dirty ? ' *' : ''}`);
  if (state.editorContext.selection?.id) items.push('选中 1');
  if (state.editorContext.compileState === 'start') items.push('编译中…');
  if (state.editorContext.compileState === 'end') items.push('编译完成');
  const build = state.editorContext.build;
  if (build?.state) {
    const percent = typeof build.progress === 'number' ? ` ${Math.round(build.progress * 100)}%` : '';
    items.push(`构建 ${build.state}${percent}`);
  }
  return items.join(' · ');
});

onMounted(async () => {
  await loadInitial();
});

watch(
  () => state.messages.length,
  () => scrollToBottom(),
);
watch(
  () => state.streaming,
  () => scrollToBottom(),
);
watch(
  () => {
    const current = state.messages.find((message) => message.streaming);
    return current ? `${current.text.length}:${current.thinking.length}:${current.toolCalls.length}` : '';
  },
  () => scrollToBottom(),
);
watch(
  () => state.agent.sessionFile,
  () => {
    void loadSessions();
  },
);
watch(
  () => state.settings?.thinking,
  (value) => {
    const level = value && value !== 'default' ? value : 'off';
    preferredThinking.value = level;
    if (thinkingLevels.value.includes(level)) thinkingLevel.value = level;
  },
  { immediate: true },
);
watch(
  () => state.agent.model,
  () => {
    syncSelectedModel();
    if (state.agent.running) void loadThinkingLevels();
  },
);
watch(
  () => state.download?.phase,
  (phase) => {
    if (phase === 'done' || phase === 'error') {
      void loadSettings();
      void loadStatus();
    }
  },
);

async function loadInitial(): Promise<void> {
  await loadAppInfo();
  await Promise.all([loadSettings(), loadStatus(), loadSessions(), loadModelProfiles()]);
  syncSelectedModel();
  await loadThinkingLevels();
  if (state.agent.running) await loadMessages();
}

async function loadModelProfiles(): Promise<void> {
  try {
    const dto = await requestRetry<ModelProfilesDTO>('model-profiles-get');
    modelProfiles.value = dto.profiles;
    selectedModelKey.value = dto.defaultProfileId ?? dto.profiles[0]?.id ?? '';
  } catch {
    modelProfiles.value = [];
  }
}

function syncSelectedModel(): void {
  const model = state.agent.model ?? '';
  const match = model ? modelProfiles.value.find((profile) => profile.modelId === model) : null;
  if (match) selectedModelKey.value = match.id;
}

/** 推理级别来自当前模型实际支持的能力，而不是固定列表。 */
async function loadThinkingLevels(profile?: ModelProfileView | null): Promise<void> {
  if (loadingThinking.value) return;
  loadingThinking.value = true;
  try {
    let levels: ThinkingLevel[] = [];
    if (state.agent.running) {
      try {
        const response = await request<{ ok: boolean; data?: { levels?: ThinkingLevel[] } }>(
          MessageName.AgentThinkingLevels,
        );
        if (response?.ok && Array.isArray(response.data?.levels)) levels = response.data.levels;
      } catch {
        // Pi 不可用时退回按模型 reasoning 标记推断
      }
    }
    if (!levels.length) {
      const selected =
        profile ?? modelProfiles.value.find((item) => item.id === selectedModelKey.value);
      levels = selected?.reasoning
        ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        : ['off'];
    }
    thinkingLevels.value = levels;
    const preferred = levels.includes(preferredThinking.value) ? preferredThinking.value : 'off';
    thinkingLevel.value = levels.includes(preferred) ? preferred : levels[0] ?? 'off';
  } finally {
    loadingThinking.value = false;
  }
}

async function applyModel(): Promise<void> {
  const profile = modelProfiles.value.find((item) => item.id === selectedModelKey.value);
  if (!profile || switchingModel.value || state.running) return;
  switchingModel.value = true;
  try {
    if (!state.agent.running) {
      const started = await request<{ ok: boolean; error?: { message?: string } }>(MessageName.AgentStart);
      if (!started?.ok) {
        setError(started?.error?.message ?? '启动 Agent 失败');
        return;
      }
    }
    const response = await request<{ ok: boolean; error?: { message?: string } }>(MessageName.AgentSetModel, {
      provider: profile.providerId,
      modelId: profile.modelId,
    });
    if (!response?.ok) {
      setError(response?.error?.message ?? '切换模型失败');
      return;
    }
    state.agent.model = profile.modelId;
    await loadStatus();
    await loadThinkingLevels(profile);
    setToast('success', `${t('composer.model')}: ${profile.name}`);
  } catch (error) {
    setError(errorText(error));
  } finally {
    switchingModel.value = false;
  }
}

async function loadAppInfo(retry = true): Promise<void> {
  try {
    state.appInfo = await request<AppInfo>(MessageName.AppInfo);
  } catch {
    state.appInfo = null;
    if (retry) setTimeout(() => void loadAppInfo(false), 800);
  }
}

async function loadSettings(): Promise<void> {
  try {
    const data = await request<SettingsGetResponse>(MessageName.SettingsGet);
    state.settings = data.settings;
    state.maskedKeys = data.maskedKeys ?? {};
    state.hasApiKey = data.hasApiKey ?? {};
    state.binary = data.binary ?? null;
  } catch (error) {
    setError(errorText(error));
  }
}

async function loadStatus(): Promise<void> {
  try {
    const status = await request<AgentStatus>(MessageName.AgentStatus);
    Object.assign(state.agent, status);
    if (!status.running) {
      state.running = false;
      state.streaming = false;
    }
  } catch {
    // 状态查询失败不阻塞面板
  }
}

async function loadMessages(): Promise<void> {
  try {
    const response = await request<{ ok: boolean; data?: { messages?: unknown[] } }>(MessageName.AgentMessages);
    if (response?.ok && Array.isArray(response.data?.messages)) {
      hydrateMessages(response.data.messages);
    }
  } catch {
    // ignore
  }
}

async function loadSessions(): Promise<void> {
  try {
    sessions.value = await requestRetry<AgentSessionSummary[]>(MessageName.AgentSessions);
    sessionsError.value = '';
  } catch (error) {
    // 典型原因：面板已更新但主进程仍是旧 bundle（agent-sessions 未注册）。
    const text = errorText(error);
    sessionsError.value = /Message does not exist/i.test(text)
      ? '主进程仍是旧版本，没有 agent-sessions 接口。请完全退出 Cocos Creator 后重新打开项目，不要只关闭面板。'
      : text;
  }
}

async function switchSession(session: AgentSessionSummary): Promise<void> {
  if (session.path === state.agent.sessionFile || state.sending) return;
  try {
    if (!state.agent.running) {
      const started = await request<{ ok: boolean; error?: { message: string } }>(MessageName.AgentStart);
      if (!started?.ok) {
        setError(errorText(started?.error));
        return;
      }
    }
    const response = await request<{ ok: boolean; error?: { message: string } }>(MessageName.AgentSwitchSession, {
      path: session.path,
    });
    if (!response?.ok) {
      setError(errorText(response?.error));
      return;
    }
    await loadMessages();
    await loadStatus();
    await loadSessions();
    setToast('info', session.preview || session.name);
  } catch (error) {
    setError(errorText(error));
  }
}

async function copyMessage(message: ChatMessage): Promise<void> {
  const text = message.text.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setToast('success', t('chat.copied'));
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      setToast('success', t('chat.copied'));
    } catch {
      setError(t('chat.copyFailed'));
    } finally {
      area.remove();
    }
  }
}

async function deleteSession(session: AgentSessionSummary): Promise<void> {
  const confirmed = window.confirm(t('sessions.deleteConfirm', { name: sessionTitle(session) }));
  if (!confirmed) return;
  try {
    const result = await request<{ ok: boolean; current?: boolean; error?: { message?: string } }>(
      MessageName.AgentSessionDelete,
      { path: session.path },
    );
    if (!result?.ok) {
      setError(errorText(result?.error));
      return;
    }
    if (result.current) {
      resetMessages();
      state.running = false;
      state.streaming = false;
    }
    await loadSessions();
    if (result.current) await loadMessages();
    setToast('info', t('sessions.deleted'));
  } catch (error) {
    setError(errorText(error));
  }
}

function sessionTitle(session: AgentSessionSummary): string {
  return session.preview || session.name;
}

function formatSessionTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

async function send(): Promise<void> {
  const text = input.value.trim();
  if (!text || state.sending) return;
  addUserMessage(text);
  input.value = '';
  clearError();
  state.sending = true;
  const wasRunning = state.running;

  try {
    const messageName = wasRunning ? MessageName.AgentSteer : MessageName.AgentPrompt;
    const response = await request<PromptResponse>(messageName, { message: text });
    if (!response?.ok) {
      setError(errorText(response?.error));
      return;
    }
    if (response.disposition !== 'handled') state.running = true;
  } catch (error) {
    setError(errorText(error));
  } finally {
    state.sending = false;
    scrollToBottom();
  }
}

async function applyThinking(): Promise<void> {
  preferredThinking.value = thinkingLevel.value;
  try {
    await request(MessageName.SettingsSet, { thinking: thinkingLevel.value });
    if (state.agent.running) {
      await request(MessageName.AgentSetThinking, { level: thinkingLevel.value }).catch(() => undefined);
    }
    setToast('success', `${t('composer.thinking')}: ${thinkingLevel.value}`);
  } catch (error) {
    setError(errorText(error));
  }
}

async function respondApproval(approved: boolean): Promise<void> {
  const id = state.approval?.id;
  if (!id) return;
  try {
    await request(MessageName.ApprovalRespond, {
      id,
      approved,
      always: approved && alwaysApprove.value,
    });
    state.approval = null;
    setToast(approved ? 'success' : 'warn', approved ? t('approval.allow') : t('approval.deny'));
  } catch (error) {
    setError(errorText(error));
  } finally {
    alwaysApprove.value = false;
  }
}

async function abort(): Promise<void> {
  try {
    await request(MessageName.AgentAbort);
    state.running = false;
    state.streaming = false;
    setToast('info', t('composer.stop'));
  } catch (error) {
    setError(errorText(error));
  }
}

async function startAgent(): Promise<void> {
  if (starting.value) return;
  starting.value = true;
  clearError();
  try {
    const response = await request<{ ok: boolean; error?: { code?: string; message: string; hint?: string } }>(
      MessageName.AgentStart,
    );
    if (!response?.ok) {
      setError(errorText(response?.error));
      if (response?.error?.code === 'PI_NOT_FOUND') setToast('warn', t('toast.piMissing'));
      return;
    }
    setToast('success', t('toast.agentStarted'));
    await loadStatus();
    await loadMessages();
  } catch (error) {
    setError(errorText(error));
  } finally {
    starting.value = false;
  }
}

async function stopAgent(): Promise<void> {
  try {
    await request(MessageName.AgentStop);
    state.running = false;
    state.streaming = false;
    setToast('info', t('toast.agentStopped'));
    await loadStatus();
  } catch (error) {
    setError(errorText(error));
  }
}

async function restartAgent(): Promise<void> {
  try {
    const response = await request<{ ok: boolean; error?: { message: string; hint?: string } }>(
      MessageName.AgentRestart,
    );
    if (!response?.ok) setError(errorText(response?.error));
    else setToast('success', t('toast.agentStarted'));
    await loadStatus();
  } catch (error) {
    setError(errorText(error));
  }
}

async function newSession(): Promise<void> {
  try {
    if (!state.agent.running) {
      const started = await request<{ ok: boolean; error?: { message: string; hint?: string } }>(MessageName.AgentStart);
      if (!started?.ok) {
        setError(errorText(started?.error));
        return;
      }
      await loadStatus();
    }
    if (state.running) {
      await request(MessageName.AgentAbort).catch(() => undefined);
    }
    const response = await request<{ ok: boolean; error?: { message: string; hint?: string } }>(MessageName.AgentNewSession);
    if (!response?.ok) {
      setError(errorText(response?.error));
      return;
    }
    resetMessages();
    state.running = false;
    state.streaming = false;
    state.sending = false;
    setToast('info', t('composer.newSession'));
    await loadStatus();
    await loadSessions();
  } catch (error) {
    setError(errorText(error));
  }
}

function openSettings(): void {
  state.drawer = 'settings';
  if (!state.settings) void loadSettings();
}

function closeSettings(): void {
  state.drawer = null;
}

async function saveSettings(patch: SettingsPatch): Promise<void> {
  try {
    const saved = await request<boolean>(MessageName.SettingsSet, patch);
    if (!saved) {
      setError('设置保存失败');
      return;
    }
    setToast('success', t('toast.settingsSaved'));
    await loadSettings();
    if (state.running && patch.provider && patch.model) {
      await request(MessageName.AgentSetModel, { provider: patch.provider, modelId: patch.model }).catch(
        () => undefined,
      );
    }
  } catch (error) {
    setError(errorText(error));
  }
}

async function downloadPi(): Promise<void> {
  try {
    const response = await request<{ ok: boolean; error?: { message: string } }>(MessageName.PiDownload);
    if (!response?.ok) setError(errorText(response?.error));
    else setToast('info', t('settings.downloading'));
  } catch (error) {
    setError(errorText(error));
  }
}

async function pickPiPath(): Promise<void> {
  try {
    const response = await request<{ ok: boolean; path?: string; canceled?: boolean }>(MessageName.PiSelectPath);
    if (response?.ok && response.path) {
      setToast('success', response.path);
      await loadSettings();
    }
  } catch (error) {
    setError(errorText(error));
  }
}

function scrollToBottom(): void {
  void nextTick(() => {
    const element = messagesEl.value;
    if (element) element.scrollTop = element.scrollHeight;
  });
}

function formatTime(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
  } catch {
    return '';
  }
}

function errorText(error: unknown): string {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  const record = error as { message?: string; hint?: string };
  return [record.message, record.hint].filter(Boolean).join('\n') || String(error);
}
</script>

<template>
  <div class="shell">
    <header v-if="!embedded" class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">◆</span>
        <span class="brand-title">{{ t('brand.title') }}</span>
        <span class="phase-pill">Phase 4</span>
      </div>

      <div class="topbar-actions">
        <ViewTabs active="chat" />
        <div class="status-dots">
          <span
            class="dot"
            :class="bridgeReady ? 'dot-jade' : 'dot-faint'"
            :title="`${t('status.bridge')}: ${bridgeReady ? t('status.ready') : t('status.pending')}`"
          ></span>
          <span
            class="dot"
            :class="state.agent.running ? 'dot-jade' : 'dot-faint'"
            :title="`${t('status.agent')}: ${agentLabel}`"
          ></span>
        </div>
        <button type="button" class="icon-btn" :title="t('settings.title')" :aria-label="t('settings.title')" @click="openSettings">
          ⚙
        </button>
      </div>
    </header>

    <div class="chat-body">
      <aside class="session-sidebar">
        <div class="side-head session-side-head">
          <h2>{{ t('sessions.title') }}</h2>
          <span class="session-actions">
            <button type="button" class="link-btn" title="刷新" @click="loadSessions">↻</button>
            <button type="button" class="link-btn" :disabled="state.sending" @click="newSession">
              ＋ {{ t('composer.newSession') }}
            </button>
          </span>
        </div>
        <p v-if="sessionsError" class="error-line session-error">{{ sessionsError }}</p>
        <div v-if="!sessions.length && !sessionsError" class="empty-line">{{ t('sessions.empty') }}</div>
        <div
          v-for="session in sessions"
          :key="session.path"
          class="session-row"
          :class="{ active: state.agent.sessionFile === session.path }"
        >
          <button
            type="button"
            class="session-open"
            :title="session.preview || session.name"
            @click="switchSession(session)"
          >
            <span class="session-row-title">{{ sessionTitle(session) }}</span>
            <span class="session-row-meta">
              {{ formatSessionTime(session.updatedAt) }}
              <template v-if="session.messageCount"> · {{ session.messageCount }}</template>
            </span>
          </button>
          <button
            type="button"
            class="session-delete"
            :title="t('sessions.delete')"
            :disabled="state.sending"
            @click.stop="deleteSession(session)"
          >
            ×
          </button>
        </div>
      </aside>

      <main class="main">
      <div class="content">
        <section v-if="!state.messages.length" class="hello-card">
          <div class="hello-kicker">
            <span class="dot dot-jade" aria-hidden="true"></span>
            <span>{{ t('hello.kicker') }}</span>
          </div>
          <h1>{{ t('hello.title') }}</h1>
          <p class="hello-copy">{{ t('hello.body') }}</p>

          <div class="status-grid">
            <div class="status-cell">
              <span class="status-label">{{ t('status.panel') }}</span>
              <span class="status-value ok">● {{ t('status.ready') }}</span>
            </div>
            <div class="status-cell">
              <span class="status-label">{{ t('status.bridge') }}</span>
              <span class="status-value" :class="bridgeReady ? 'ok' : 'pending'">
                {{ bridgeReady ? '●' : '○' }} {{ bridgeReady ? t('status.ready') : t('status.pending') }}
              </span>
            </div>
            <div class="status-cell">
              <span class="status-label">{{ t('status.agent') }}</span>
              <span class="status-value" :class="state.agent.running ? 'ok' : 'pending'">
                {{ state.agent.running ? '●' : '○' }} {{ agentLabel }}
              </span>
            </div>
            <div class="status-cell">
              <span class="status-label">{{ t('status.editor') }}</span>
              <span class="status-value ok">● {{ editorLabel }}</span>
            </div>
          </div>

          <div class="button-row hello-actions">
            <button type="button" class="btn primary" :disabled="starting" @click="startAgent">
              {{ starting ? t('agent.starting') : t('agent.start') }}
            </button>
            <button type="button" class="btn" @click="openSettings">{{ t('settings.title') }}</button>
            <button type="button" class="btn ghost" :disabled="state.sending" @click="newSession">
              ＋ {{ t('composer.newSession') }}
            </button>
          </div>
          <p class="hint-line">{{ binaryLabel }}</p>
        </section>

        <section v-else ref="messagesEl" class="chat-list">
          <article
            v-for="message in state.messages"
            :key="message.id"
            class="chat-message"
            :class="`chat-${message.role}`"
          >
            <template v-if="message.role === 'user'">
              <div class="bubble user-bubble">{{ message.text }}</div>
              <div class="message-time">{{ formatTime(message.timestamp) }}</div>
            </template>

            <template v-else>
              <div class="agent-head">
                <span class="dot dot-amber" aria-hidden="true"></span>
                <span class="agent-name">{{ t('chat.agent') }}</span>
                <span class="message-time">{{ formatTime(message.timestamp) }}</span>
              </div>
              <div class="assistant-text">
                {{ message.text }}<span v-if="message.streaming" class="stream-cursor" aria-hidden="true"></span>
              </div>
              <details
                v-if="message.thinking"
                class="thinking-block"
                :open="message.streaming && !message.text"
              >
                <summary>
                  {{ t('chat.thinking') }}<span v-if="message.streaming && !message.text" class="stream-cursor" aria-hidden="true"></span>
                </summary>
                <pre>{{ message.thinking }}</pre>
              </details>
              <ToolCard v-for="tool in message.toolCalls" :key="tool.id" :tool="tool" />
              <p v-if="message.error" class="error-line">{{ message.error }}</p>
              <button
                v-if="message.text && !message.streaming"
                type="button"
                class="link-btn message-copy"
                @click="copyMessage(message)"
              >
                {{ t('chat.copy') }}
              </button>
            </template>
          </article>
          <div v-if="waitingForReply" class="typing-indicator">
            <span>
              {{ t('chat.waiting') }}
              <template v-if="waitingSeconds">{{ waitingSeconds }}s</template>
            </span>
            <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
          </div>
          <div v-if="waitingForReply && waitingSeconds >= 30" class="typing-hint">
            {{ t('chat.waitingHint') }}
          </div>
        </section>

      </div>
      </main>
    </div>

    <footer class="composer">
      <div v-if="state.error" class="composer-error">
        <span class="composer-error-text">{{ state.error }}</span>
        <button type="button" class="link-btn" :title="t('settings.close')" @click="clearError">×</button>
      </div>
      <div v-if="state.approval" class="approval-bar">
        <div class="approval-head">
          <span class="dot dot-amber" aria-hidden="true"></span>
          <strong>{{ t('approval.title') }}</strong>
          <span class="approval-tool">{{ state.approval.tool }}</span>
          <span class="approval-risk">{{ state.approval.risk }}</span>
        </div>
        <p class="approval-summary">{{ state.approval.summary }}</p>
        <details v-if="state.approval.argsPreview" class="approval-args">
          <summary>{{ t('chat.toolArgs') }}</summary>
          <pre>{{ state.approval.argsPreview }}</pre>
        </details>
        <div class="approval-actions">
          <label class="check-row">
            <input v-model="alwaysApprove" type="checkbox" />
            <span>{{ t('approval.always') }}</span>
          </label>
          <button type="button" class="btn" @click="respondApproval(false)">{{ t('approval.deny') }}</button>
          <button type="button" class="btn primary" @click="respondApproval(true)">{{ t('approval.allow') }}</button>
        </div>
      </div>

      <div v-if="state.queued" class="queue-line">{{ t('composer.queued', { count: state.queued }) }}</div>
      <div class="composer-toolbar">
        <div class="composer-tools-left">
          <label v-if="modelProfiles.length" class="thinking-select model-select">
            <span>{{ t('composer.model') }}</span>
            <select
              v-model="selectedModelKey"
              :disabled="state.running || switchingModel"
              @change="applyModel"
            >
              <option v-for="profile in modelProfiles" :key="profile.id" :value="profile.id">
                {{ profile.name }}
              </option>
            </select>
          </label>
          <label class="thinking-select">
            <span>{{ t('composer.thinking') }}</span>
            <select
              v-model="thinkingLevel"
              :disabled="state.running || !thinkingLevels.length"
              @change="applyThinking"
            >
              <option v-for="level in thinkingLevels" :key="level" :value="level">{{ level }}</option>
            </select>
          </label>
          <button type="button" class="btn ghost compact-btn" :disabled="state.sending" @click="newSession">
            ＋ {{ t('composer.newSession') }}
          </button>
        </div>
        <span v-if="state.agent.model && !modelProfiles.length" class="composer-model">{{ state.agent.model }}</span>
      </div>
      <div class="composer-row">
        <textarea
          v-model="input"
          rows="2"
          :placeholder="t('composer.placeholder')"
          @keydown.enter.exact.prevent="send"
          @keydown.esc="abort"
        ></textarea>
        <div class="composer-actions">
          <button v-if="state.running" type="button" class="btn danger" @click="abort">
            {{ t('composer.stop') }}
          </button>
          <button type="button" class="btn primary" :disabled="!canSend" @click="send">
            {{ state.running ? t('composer.steer') : t('composer.send') }}
          </button>
        </div>
      </div>
      <div class="composer-foot">
        <span>{{ state.compacting ? '上下文压缩中…' : t('composer.placeholder') }}</span>
        <span class="agent-meta">
          <template v-if="state.agent.running">
            {{ agentLabel }}
            <template v-if="state.agent.pid"> · {{ t('agent.pid', { pid: state.agent.pid }) }}</template>
            <template v-if="state.agent.toolCount"> · {{ t('agent.tools', { count: state.agent.toolCount }) }}</template>
          </template>
          <template v-else>{{ t('agent.stoppedHint') }}</template>
        </span>
      </div>
    </footer>

    <footer class="statusbar">
      <span>{{ footerName }}</span>
      <span class="telemetry">{{ telemetry }}</span>
      <span class="local">{{ binaryLabel }}</span>
    </footer>

    <SettingsDrawer
      v-if="state.settings && state.drawer === 'settings'"
      :settings="state.settings"
      :masked-keys="state.maskedKeys"
      :has-api-key="state.hasApiKey"
      :binary="state.binary"
      :download="state.download"
      @close="closeSettings"
      @save="saveSettings"
      @download="downloadPi"
      @select-path="pickPiPath"
    />

    <div v-if="state.toast" class="toast" :class="`toast-${state.toast.level}`">
      {{ state.toast.message }}
    </div>
  </div>
</template>
