<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown } from '../markdown';

const props = defineProps<{ text: string }>();
const html = computed(() => renderMarkdown(props.text, { chat: true }));
</script>

<template>
  <div class="markdown-body reply-markdown" v-html="html"></div>
</template>
