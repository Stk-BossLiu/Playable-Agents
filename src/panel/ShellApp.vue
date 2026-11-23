<script setup lang="ts">
import { computed } from 'vue';
import BoardApp from './BoardApp.vue';
import ChatApp from './App.vue';
import StatusApp from './StatusApp.vue';
import { state } from './store';

type ViewName = 'board' | 'chat' | 'status';

const views = { board: BoardApp, chat: ChatApp, status: StatusApp };
const activeView = computed({
  get: () => state.activeView,
  set: (value: ViewName) => {
    state.activeView = value;
  },
});
const currentView = computed(() => views[state.activeView]);

function openSettings(): void {
  state.drawer = 'settings';
  state.activeView = 'chat';
}
</script>

<template>
  <div class="shell shell-host">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">◆</span>
        <span class="brand-title">Cocos AI Agent</span>
        <span class="phase-pill">Phase 4</span>
      </div>
      <div class="topbar-actions">
        <nav class="inner-tabs" role="tablist" aria-label="Cocos AI Agent views">
          <button
            type="button"
            class="inner-tab"
            :class="{ active: activeView === 'board' }"
            @click="activeView = 'board'"
          >
            画板
          </button>
          <button
            type="button"
            class="inner-tab"
            :class="{ active: activeView === 'chat' }"
            @click="activeView = 'chat'"
          >
            对话
          </button>
          <button
            type="button"
            class="inner-tab"
            :class="{ active: activeView === 'status' }"
            @click="activeView = 'status'"
          >
            Agent 状态
          </button>
        </nav>
        <button type="button" class="icon-btn" title="设置" aria-label="设置" @click="openSettings">⚙</button>
      </div>
    </header>

    <div class="shell-view">
      <component :is="currentView" embedded />
    </div>
  </div>
</template>
