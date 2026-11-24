<script setup lang="ts">
import { computed } from 'vue';
import type { ModelProfileView } from '../../shared/models';
import { groupModelProviders } from '../model-providers';
import { t } from '../i18n';

const props = defineProps<{
  profiles: ModelProfileView[]; params: Record<string, unknown>; disabled: boolean;
  field: 'provider' | 'model'; defaultLabel?: string;
}>();
const emit = defineEmits<{ change: [profile?: ModelProfileView] }>();
const groups = computed(() => groupModelProviders(props.profiles));
const current = computed(() => props.profiles.find(profile => props.params.provider && props.params.model
  ? profile.providerId === props.params.provider && profile.modelId === props.params.model
  : profile.id === props.params.modelProfileId));
const provider = computed(() => groups.value.find(group => current.value && group.profiles.includes(current.value)));
</script>
<template>
  <select v-if="field === 'provider'" :value="provider?.key ?? ''" :disabled="disabled"
    @change="emit('change', groups.find(group => group.key === ($event.target as HTMLSelectElement).value)?.profiles[0])">
    <option value="">{{ defaultLabel ?? t('board.useDefault') }}</option>
    <option v-for="group in groups" :key="group.key" :value="group.key">{{ group.name }}</option>
  </select>
  <select v-else :value="current?.id ?? ''" :disabled="disabled || !provider"
    @change="emit('change', provider?.profiles.find(profile => profile.id === ($event.target as HTMLSelectElement).value))">
    <option v-if="!provider" value="">{{ defaultLabel ?? t('board.useDefault') }}</option>
    <option v-for="profile in provider?.profiles" :key="profile.id" :value="profile.id">{{ profile.modelId }}</option>
  </select>
</template>
