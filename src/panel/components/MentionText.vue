<script setup lang="ts">
import { computed } from 'vue';
import { mentionParts } from '../mentions';

const props = defineProps<{ text: string }>();
const parts = computed(() => mentionParts(props.text));
</script>

<template>
  <template v-for="(part, index) in parts" :key="index"><template v-if="part.kind === 'text'">{{ part.raw }}</template><span v-else
    class="mention-chip" :class="`mention-chip-${part.kind}`" :title="part.path">{{ part.name }}</span></template>
</template>
