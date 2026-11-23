<script setup lang="ts">
import { computed, ref } from 'vue';
import { MessageName } from '../../shared/protocol';
import { request } from '../api';
import { t } from '../i18n';
import { renderMarkdown } from '../markdown';
import { setToast, state } from '../store';

const alwaysApprove = ref(false);
const feedback = ref('');

function stringifyPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

const humanMarkdown = computed(() => {
  const value = state.humanRequest?.payload;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const markdown = (value as Record<string, unknown>).markdown;
  return typeof markdown === 'string' ? markdown : '';
});

const humanJson = computed(() => {
  const value = state.humanRequest?.payload;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const json = (value as Record<string, unknown>).json;
  return json === undefined ? '' : stringifyPayload(json);
});

/** 审批栏里展示的待确认内容：优先 markdown，其次 json，最后原样展示 payload。 */
const humanPayloadBody = computed(() => {
  if (humanMarkdown.value.trim()) return humanMarkdown.value;
  if (humanJson.value) return humanJson.value;
  const value = state.humanRequest?.payload;
  return value === undefined ? '' : stringifyPayload(value);
});

const showHumanJson = computed(
  () => Boolean(humanJson.value) && humanJson.value !== humanPayloadBody.value,
);

/** 把计划 Markdown 渲染成排版后的文档。 */
const humanHtml = computed(() => renderMarkdown(humanMarkdown.value));

async function copyPayload(): Promise<void> {
  const text = humanPayloadBody.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setToast('success', t('approval.copied'));
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      setToast('success', t('approval.copied'));
    } catch {
      setToast('warn', t('approval.copyFailed'));
    } finally {
      area.remove();
    }
  }
}

async function respondTool(approved: boolean): Promise<void> {
  const id = state.approval?.id;
  if (!id) return;
  try {
    await request(MessageName.ApprovalRespond, { id, approved, always: approved && alwaysApprove.value });
    state.approval = null;
    setToast(approved ? 'success' : 'warn', approved ? t('approval.allow') : t('approval.deny'));
  } finally {
    alwaysApprove.value = false;
  }
}

async function respondHuman(decision: 'approve' | 'reject', optionId?: string): Promise<void> {
  const requestId = state.humanRequest?.id;
  if (!requestId) return;
  try {
    await request('graph-human-respond', {
      id: requestId,
      decision,
      ...(feedback.value.trim() ? { feedback: feedback.value.trim() } : {}),
      ...(optionId ? { optionId } : {}),
    });
    state.humanRequest = null;
    feedback.value = '';
    setToast(decision === 'approve' ? 'success' : 'warn', decision === 'approve' ? t('approval.allow') : t('approval.deny'));
  } catch (caught) {
    setToast('error', caught instanceof Error ? caught.message : String(caught));
  }
}
</script>

<template>
  <div v-if="state.humanRequest" class="approval-bar global-approval">
    <div class="approval-head">
      <span class="dot dot-amber" aria-hidden="true"></span>
      <strong>{{ state.humanRequest.title }}</strong>
      <span class="approval-tool">{{ state.humanRequest.nodeId }}</span>
      <span class="approval-risk">approval</span>
    </div>
    <p v-if="state.humanRequest.description" class="approval-summary">{{ state.humanRequest.description }}</p>

    <div v-if="humanPayloadBody" class="human-payload">
      <div class="human-payload-head">
        <span>{{ t('approval.payload') }}</span>
        <button type="button" class="link-btn" @click="copyPayload">{{ t('approval.copy') }}</button>
      </div>
      <div
        v-if="humanHtml"
        class="human-payload-body markdown-body"
        v-html="humanHtml"
      ></div>
      <pre v-else class="human-payload-body">{{ humanPayloadBody }}</pre>
      <details v-if="showHumanJson" class="approval-args">
        <summary>JSON</summary>
        <pre>{{ humanJson }}</pre>
      </details>
    </div>
    <div v-else class="empty-line approval-empty">{{ t('approval.noPayload') }}</div>

    <div v-if="state.humanRequest.options?.length" class="human-options">
      <button
        v-for="option in state.humanRequest.options"
        :key="option.id"
        type="button"
        class="btn"
        @click="respondHuman('approve', option.id)"
      >
        {{ option.label }}
      </button>
    </div>
    <textarea v-model="feedback" class="human-feedback" rows="2" :placeholder="t('approval.feedback')"></textarea>
    <div class="approval-actions">
      <button type="button" class="btn" @click="respondHuman('reject')">{{ t('approval.deny') }}</button>
      <button type="button" class="btn primary" @click="respondHuman('approve')">{{ t('approval.allow') }}</button>
    </div>
  </div>

  <div v-else-if="state.approval" class="approval-bar global-approval">
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
      <button type="button" class="btn" @click="respondTool(false)">{{ t('approval.deny') }}</button>
      <button type="button" class="btn primary" @click="respondTool(true)">{{ t('approval.allow') }}</button>
    </div>
  </div>
</template>
