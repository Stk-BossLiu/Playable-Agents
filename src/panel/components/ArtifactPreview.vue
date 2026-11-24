<script setup lang="ts">
defineProps<{ preview: { name: string; mime: string; encoding: string; content: string } }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <div class="artifact-preview">
    <div class="side-head">
      <strong>{{ preview.name }}</strong>
      <button type="button" class="link-btn" aria-label="关闭预览" @click="$emit('close')">×</button>
    </div>
    <img v-if="preview.mime.startsWith('image/')" :src="`data:${preview.mime};base64,${preview.content}`" :alt="preview.name" />
    <pre v-else-if="preview.encoding === 'utf8'">{{ preview.content }}</pre>
    <p v-else class="muted">二进制产物（{{ preview.mime }}）</p>
  </div>
</template>
