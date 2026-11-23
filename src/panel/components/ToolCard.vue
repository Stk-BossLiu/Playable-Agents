<script setup lang="ts">
import { computed } from 'vue';
import { formatJsonText, formatJsonValue } from '../format';
import { t } from '../i18n';
import type { ToolCallView } from '../store';

const props = defineProps<{ tool: ToolCallView }>();

const statusText = computed(() => {
  if (props.tool.status === 'running') return t('chat.toolRunning');
  if (props.tool.status === 'success') return t('chat.toolSuccess');
  return t('chat.toolError');
});

const argsText = computed(() => {
  if (props.tool.status !== 'running' && props.tool.args !== undefined) {
    return formatJsonValue(props.tool.args);
  }
  if (props.tool.argsText) return formatJsonText(props.tool.argsText);
  if (props.tool.args === undefined) return '{}';
  return formatJsonValue(props.tool.args);
});

const resultText = computed(() => formatJsonText(props.tool.resultText ?? ''));

const duration = computed(() => {
  if (props.tool.durationMs === undefined) return '';
  if (props.tool.durationMs < 1000) return `${props.tool.durationMs}ms`;
  return `${(props.tool.durationMs / 1000).toFixed(1)}s`;
});
</script>

<template>
  <div class="tool-card" :class="`tool-${tool.status}`">
    <div class="tool-head">
      <span class="tool-spine" aria-hidden="true"></span>
      <span class="tool-name">{{ tool.name }}</span>
      <span class="tool-status">{{ statusText }}</span>
      <span v-if="duration" class="tool-duration">{{ duration }}</span>
    </div>

    <details class="tool-section">
      <summary>{{ t('chat.toolArgs') }}</summary>
      <pre>{{ argsText }}</pre>
    </details>

    <details v-if="resultText" class="tool-section">
      <summary>{{ t('chat.toolResult') }}</summary>
      <pre>{{ resultText }}</pre>
    </details>
  </div>
</template>
