<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { playableStages } from '../../shared/playable';
import type { GraphRunView, NodeResultView } from '../store';

type Stage = typeof playableStages[number][0];
interface Artifact { name?: string; path?: string; type?: string }
const props = defineProps<{
  graphName: string; nodeTitle: string; nodeId: string; result?: NodeResultView;
  logs: GraphRunView['logs']; artifacts: Artifact[]; loading: boolean;
}>();
const emit = defineEmits<{ back: []; select: []; preview: [artifact: Artifact] }>();
const details: Record<Stage, { input: string; action: string; output: string; files: string[] }> = {
  source: { input: '参考试玩 HTML 文件', action: '检查文件格式和大小，读取 HTML 并计算文件摘要。', output: 'HTML、字节数、SHA-256', files: ['evidence.json'] },
  inventory: { input: 'HTML 文本', action: '将素材与代码分别保存到项目 playable-analyse 下的 assets 和 scripts 目录。', output: '资源清单、脚本索引、引擎线索', files: ['assets.json', 'evidence.json'] },
  rea: { input: '拆解目录中的 JavaScript 文件', action: '调用 REA 分析脚本结构，并记录可用于架构分析的静态证据。', output: 'REA 分析摘要或诊断', files: ['evidence.json'] },
  analysis: { input: '资源、代码线索和 REA 摘要', action: '按证据分析玩法、设计逻辑、资源和项目架构，校验每条结论引用的证据编号。', output: '带证据引用的分析结论', files: ['evidence.json'] },
  report: { input: '分析结论、索引和覆盖范围', action: '汇总分析报告，并将报告和证据清单保存到项目 docs。', output: 'Markdown 报告和 JSON 产物', files: ['playable-analysis.md', 'assets.json', 'evidence.json'] },
};
const active = ref<Stage>('source');
const back = ref<HTMLButtonElement | null>(null);
onMounted(() => back.value?.focus());
const detail = computed(() => details[active.value]);
const title = computed(() => playableStages.find(([id]) => id === active.value)?.[1]);
const files = computed(() => props.artifacts.filter(file => {
  const name = (file.name || file.path || '').split(/[\\/]/).pop() ?? '';
  return detail.value.files.includes(name);
}));
const lastStage = computed(() => {
  const labels = playableStages.map(([, label]): string => label);
  return props.logs.filter(log => log.nodeId === props.nodeId && log.level === 'info' && labels.includes(log.message)).at(-1)?.message;
});
function status(id: Stage, label: string): string {
  const output = props.result?.outputs?.json;
  if (output && typeof output === 'object') {
    if ('status' in output && output.status === 'skipped') return '已跳过';
    if ('stages' in output && output.stages && typeof output.stages === 'object') {
      const value: unknown = Reflect.get(output.stages, id);
      if (typeof value === 'string') return value;
    }
  }
  if (props.result?.state === 'skipped') return '已跳过';
  if (label === lastStage.value) {
    if (props.result?.state === 'running') return '进行中';
    if (props.result?.state === 'error') return '出错';
  }
  return props.result ? '无阶段结果' : '尚未运行';
}
function select(id: Stage): void {
  if (id === active.value) return;
  active.value = id;
  emit('select');
}
</script>

<template>
  <section class="board-stage playable-subgraph">
    <nav class="board-toolbar" aria-label="子图导航">
      <button ref="back" type="button" class="btn" :title="graphName" @click="emit('back')">← 返回父图</button>
      <strong>{{ graphName }} / {{ nodeTitle }}</strong>
    </nav>
    <div class="playable-subgraph-body">
      <ol class="stage-flow" aria-label="分析执行顺序">
        <li v-for="[id, label] in playableStages" :key="id">
          <button type="button" :aria-pressed="id === active" @click="select(id)">
            <strong>{{ label }}</strong><small>{{ status(id, label) }}</small>
          </button>
        </li>
      </ol>
      <section class="stage-detail" aria-label="阶段详情">
        <h3>{{ title }}</h3><p>{{ detail.action }}</p>
        <slot v-if="active === 'analysis'" name="agent" />
        <dl><dt>输入</dt><dd>{{ detail.input }}</dd><dt>输出</dt><dd>{{ detail.output }}</dd></dl>
        <p v-if="result?.error" class="error-line">父节点运行错误 · {{ result.error }}</p>
        <button v-for="file in files" :key="file.path ?? file.name" class="artifact-row" type="button"
          :disabled="loading || !file.path" @click="emit('preview', file)">{{ file.name ?? file.path }}</button>
        <slot />
      </section>
    </div>
  </section>
</template>
