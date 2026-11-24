<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { editorSelection, editorText, renderEditor } from '../mention-editor';
import { matchChatCommands, type ChatCommand } from '../chat-commands';
import { droppedMentions, isMentionDrag } from '../mention-drop';
import { t } from '../i18n';
import { insertMention, matchMentions, mentionRange, nodeMentions, type Mention, type MentionRange } from '../mentions';

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [text: string]; send: []; abort: [] }>();
const area = ref<HTMLDivElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const range = shallowRef<MentionRange | null>(null);
const items = shallowRef<Mention[]>([]);
const pending = ref(false);
const failures = ref<string[]>([]);
const active = ref(0);
const matches = computed(() => range.value ? matchMentions(items.value, range.value.query) : []);
let generation = 0;

const dragging = ref(false);
const dropError = ref(false);
let dropRequest = 0;

function dragOver(event: DragEvent): void {
  if (!isMentionDrag(event.dataTransfer)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  dragging.value = true;
}

async function drop(event: DragEvent): Promise<void> {
  dragging.value = false;
  const transfer = event.dataTransfer;
  const el = area.value;
  if (!transfer || !el) return;
  if (!isMentionDrag(transfer)) {
    event.preventDefault();
    const plain = transfer.getData('text/plain');
    if (plain) replaceSelection(plain);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const request = ++dropRequest;
  const original = editorText(el);
  const selection = editorSelection(el);
  const start = range.value?.start ?? selection.start;
  const end = selection.end;
  close();
  dropError.value = false;
  try {
    const refs = await droppedMentions(transfer);
    if (request !== dropRequest || !area.value) return;
    if (!refs.length) { dropError.value = true; return; }
    const current = editorText(el);
    const latest = editorSelection(el);
    const unchanged = current === original;
    let caret = unchanged ? start : latest.start;
    let text = current;
    let replaceEnd = unchanged ? end : latest.end;
    for (const item of refs) {
      const result = insertMention(text, { start: caret, end: replaceEnd, query: '' }, item);
      text = result.text;
      caret = replaceEnd = result.caret;
    }
    commit(text, caret);
  } catch {
    if (request === dropRequest) dropError.value = true;
  }
}

function close(): void {
  generation++;
  range.value = null;
  items.value = [];
  failures.value = [];
}

async function load(): Promise<void> {
  const token = ++generation;
  pending.value = true;
  async function read(kind: Mention['kind']): Promise<void> {
    try {
      const rows: Mention[] = kind === 'node'
        ? nodeMentions(await Editor.Message.request('scene', 'query-node-tree'))
        : (await Editor.Message.request('asset-db', 'query-assets', { pattern: 'db://assets/**' }, ['url', 'uuid', 'isDirectory']))
            .filter(asset => asset.url && !asset.isDirectory)
            .map(asset => ({ kind, path: asset.url, uuid: asset.uuid }));
      if (token === generation) items.value = items.value.concat(rows);
    } catch {
      if (token === generation) failures.value.push(t(kind === 'node' ? 'mention.nodesFailed' : 'mention.assetsFailed'));
    }
  }
  await Promise.all([read('node'), read('asset')]);
  if (token === generation) pending.value = false;
}

function sync(): void {
  const el = area.value;
  const selection = el && editorSelection(el);
  const next = el && selection && selection.start === selection.end ? mentionRange(editorText(el), selection.start) : null;
  if (!next) { if (range.value) close(); return; }
  const opening = !range.value;
  if (opening || next.query !== range.value?.query) active.value = 0;
  range.value = next;
  if (opening) void load();
}

function onInput(event: Event): void {
  if ((event as InputEvent).isComposing) return;
  dropError.value = false;
  if (!area.value) return;
  emit('update:modelValue', editorText(area.value));
  sync();
}

function commit(text: string, caret: number): void {
  if (!area.value) return;
  renderEditor(area.value, text, caret);
  emit('update:modelValue', text);
}

function replaceSelection(value: string): void {
  if (!area.value) return;
  const text = editorText(area.value);
  const { start, end } = editorSelection(area.value);
  commit(text.slice(0, start) + value + text.slice(end), start + value.length);
  sync();
}

function beforeInput(event: InputEvent): void {
  if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
    event.preventDefault();
    replaceSelection('\n');
  }
}

function choose(item: Mention): void {
  if (!area.value || !range.value) return;
  const result = insertMention(editorText(area.value), range.value, item);
  close();
  commit(result.text, result.caret);
}

const commands = computed(() => matchChatCommands(props.modelValue));
const commandIndex = ref(0);
const commandMenuOpen = ref(false);
watch(() => props.modelValue, value => {
  commandIndex.value = 0;
  commandMenuOpen.value = matchChatCommands(value).length > 0;
});
function selectCommand(command: ChatCommand): void {
  commit(`${command} `, command.length + 1);
  commandMenuOpen.value = false;
}

function keydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  const key = event.key;
  if (commandMenuOpen.value && commands.value.length) {
    if (key === 'Escape') { event.preventDefault(); commandMenuOpen.value = false; return; }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      commandIndex.value = (commandIndex.value + (key === 'ArrowDown' ? 1 : -1) + commands.value.length) % commands.value.length;
      return;
    }
    if (key === 'Tab' || (key === 'Enter' && props.modelValue !== commands.value[commandIndex.value])) {
      event.preventDefault(); selectCommand(commands.value[commandIndex.value]); return;
    }
  }
  if (range.value) {
    if (key === 'Escape') { event.preventDefault(); close(); return; }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      const count = matches.value.length;
      if (count) {
        active.value = (active.value + (key === 'ArrowDown' ? 1 : -1) + count) % count;
        menu.value?.querySelectorAll('[role="option"]')[active.value]?.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    if (key === 'Enter' || (key === 'Tab' && matches.value.length)) {
      event.preventDefault();
      const item = matches.value[active.value];
      if (item) void choose(item);
      return;
    }
  }
  if (key === 'Enter') { event.preventDefault(); emit('send'); }
  if (key === 'Escape') emit('abort');
}
onMounted(() => { if (area.value) renderEditor(area.value, props.modelValue); });
watch(() => props.modelValue, value => {
  if (!value) close();
  if (area.value && editorText(area.value) !== value) renderEditor(area.value, value);
});
onBeforeUnmount(close);
</script>

<template>
  <div class="mention-composer" :class="{ dragging }" @dragover="dragOver" @dragleave="dragging = false" @drop="drop">
    <div v-if="dragging" class="mention-drop-hint">{{ t('mention.drop') }}</div>
    <div v-else-if="dropError" role="status" class="mention-drop-error">{{ t('mention.dropError') }}</div>
    <div v-if="commandMenuOpen && commands.length && !dragging" class="mention-pop">
      <div class="mention-menu" role="listbox" :aria-label="t('commands.title')">
        <button v-for="(command, index) in commands" :key="command" type="button" role="option" tabindex="-1"
          :aria-selected="commandIndex === index" :class="{ selected: commandIndex === index }"
          @mousedown.prevent @click="selectCommand(command)"><b>{{ command }}</b><span>{{ t(command === '/compact' ? 'commands.compact' : 'composer.newSession') }}</span></button>
      </div>
    </div>
    <div v-if="range && !dragging" class="mention-pop">
      <header><strong>{{ t('mention.title') }}</strong><kbd>↑ ↓ · Enter</kbd></header>
    <div ref="menu" class="mention-menu" role="listbox" :aria-label="t('mention.title')">
      <button v-for="(item, index) in matches" :key="item.kind + item.uuid + item.path" type="button" role="option"
        tabindex="-1" :aria-selected="index === active" :class="{ selected: index === active }" :title="item.path"
        @mousedown.prevent @click="choose(item)">
        <small :class="item.kind">{{ t(item.kind === 'asset' ? 'mention.asset' : 'mention.node') }}</small><span class="mention-label"><b>{{ item.path.slice(item.path.lastIndexOf('/') + 1) }}</b><span dir="auto">{{ item.path.slice(0, item.path.lastIndexOf('/')) || '/' }}</span></span>
      </button>
      <div v-if="pending">{{ t('mention.loading') }}</div>
      <div v-else-if="!matches.length && !failures.length">{{ t('mention.empty') }}</div>
      <div v-for="failure in failures" :key="failure">{{ failure }}</div>
    </div>
    </div>
    <div ref="area" class="mention-editor" contenteditable="true" role="textbox" aria-multiline="true"
      :aria-label="t('composer.placeholder')" :data-placeholder="t('composer.placeholder')" :data-empty="!modelValue"
      @beforeinput="beforeInput" @paste.prevent="replaceSelection($event.clipboardData?.getData('text/plain') ?? '')"
      @input="onInput" @compositionend="onInput" @click="sync" @keyup.left="sync" @keyup.right="sync"
      @keydown="keydown" @blur="close(); commandMenuOpen = false" @focus="commandMenuOpen = commands.length > 0"></div>
  </div>
</template>
