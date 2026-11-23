<script setup lang="ts">
import { request } from '../api';
import { t } from '../i18n';

const props = defineProps<{ active: 'board' | 'chat' | 'status' }>();

const views = [
  { id: 'board', label: 'view.board' },
  { id: 'chat', label: 'view.chat' },
  { id: 'status', label: 'view.status' },
] as const;

async function open(view: string): Promise<void> {
  if (view === props.active) return;
  try {
    await request('open-panel', { view });
  } catch {
    // 面板切换失败时保持当前页
  }
}
</script>

<template>
  <nav class="view-tabs" role="tablist" :aria-label="t('view.label')">
    <button
      v-for="item in views"
      :key="item.id"
      type="button"
      role="tab"
      class="view-tab"
      :class="{ active: item.id === active }"
      :aria-selected="item.id === active"
      @click="open(item.id)"
    >
      {{ t(item.label) }}
    </button>
  </nav>
</template>
