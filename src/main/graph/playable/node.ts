import { basename } from 'node:path';
import type { ArtifactRef } from '../../../shared/graph';
import { playableStages } from '../../../shared/playable';
import type { NodeDefinition } from '../nodes/types';
import { inspectPlayable, readPlayable } from './html';
import { inspectScripts } from './rea';
import { extractPlayable } from './extract';

import { analyzeEvidence, reverseModelParams, topics, type Finding } from './analyst';

export const playableNode: NodeDefinition = {
  type: 'analysis.rea-reverse', category: 'subgraph', label: '参考试玩分析（REA）',
  description: '拆解本地 HTML，保存资源和代码并静态分析玩法。',
  inputs: [{ name: 'artifact', type: 'artifact', required: false }], outputs: [{ name: 'json', type: 'json', required: true }],
  paramsSchema: { type: 'object', properties: {
    ...reverseModelParams,
    prompt: { type: 'string', description: '分析侧重点（可选）' },
  }, additionalProperties: true },
  async run(ctx) {
    if (!ctx.inputs.artifact) return { outputs: { json: { available: false, status: 'skipped', reason: '未提供参考试玩' } } };
    const input = ctx.inputs.artifact;
    const path = typeof input === 'object' && 'path' in input ? input.path : undefined;
    const warnings: string[] = [], artifacts: ArtifactRef[] = [];
    const stage = (id: typeof playableStages[number][0]) => { ctx.signal.throwIfAborted(); ctx.log('info', playableStages.find(s => s[0] === id)![1]); };
    const warn = (message: string) => { ctx.signal.throwIfAborted(); warnings.push(message); ctx.log('warn', message); };
    stage('source');
    const source = await readPlayable(path);
    stage('inventory');
    const inventory = inspectPlayable(source.html);
    const { clues, limits } = inventory;
    const { directory, scriptsDir, sources, assets, code: index } = await extractPlayable(ctx.projectRoot, String(path), source.sha256, inventory, ctx.signal);
    ctx.log('info', `拆解目录 ${directory}`);
    const unresolved = assets.filter(a => a.reason).length;
    if (unresolved) warn(`${unresolved} 条资源引用仅记录在索引中，详见 assets.json`);
    limits.forEach(warn);
    stage('rea');
    let rea: Awaited<ReturnType<typeof inspectScripts>> | undefined;
    try { rea = await inspectScripts(scriptsDir, sources, ctx.signal); }
    catch (error) { warn(`REA · ${message(error)}`); }
    if (rea?.truncated) warn('REA 摘要已截取');
    stage('analysis');
    const sample = [...assets].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).slice(0, 48);
    const evidence = { assets: sample, scripts: index.slice(0, 48), clues: clues.slice(0, 72),
      ...(rea ? { R1: rea.summary.slice(0, 3500) } : {}) };
    let analysis: Finding[] = [];
    try {
      analysis = await analyzeEvidence(ctx, evidence);
    } catch (error) { warn(`模型分析 · ${message(error)}`); }
    if (topics.some(t => !analysis.some(row => row.topic === t))) warn('部分主题缺少可引用的分析结论');
    const title = basename(String(path));
    const sections = topics.map(topic => {
      const rows = analysis.filter(r => r.topic === topic).map(r => `- ${r.text} [${r.refs.join(', ')}]`);
      if (topic === '资源') rows.unshift(`- HTML ${source.bytes} 字节，索引到 ${assets.length} 条资源引用。已落盘 ${assets.filter(a => a.path).length} 条引用或数据块，REA 输入 ${sources.length} 个脚本。`);
      if (topic === '项目架构') rows.push(...clues.filter(c => c.label === '引擎线索').slice(0, 3).map(c => `- 静态线索 [${c.id}]，位于 ${c.script}，HTML 偏移 ${c.offset}`));
      return `## ${topic}\n\n${rows.join('\n') || '待确认'}`;
    });
    stage('report');
    const add = async (name: string, value: unknown, type: 'json' | 'markdown' = 'json') => {
      ctx.signal.throwIfAborted();
      artifacts.push(await ctx.writeArtifact({ type, path: name, content: type === 'json' ? JSON.stringify(value, null, 2) : String(value) }));
    };
    await add('assets.json', { directory, basis: '按引用出现位置计数，path 相对拆解目录', assets });
    await add('evidence.json', { title, sha256: source.sha256, offsetUnit: 'UTF-16 / decoded HTML', scripts: index, clues,
      directory, reaSources: sources, assets: 'assets.json', R1: rea, analysis, warnings });
    await add('playable-analysis.md', [`# ${title}`, ...sections, '## 覆盖范围', `拆解目录 ${directory}。结论基于静态证据，运行时生成的资源和行为待核实。`, ...warnings].join('\n\n'), 'markdown');
    return { artifacts, outputs: { json: { available: true, status: warnings.length ? 'partial' : 'ok', title, stages: { source: '完成', inventory: limits.length || unresolved ? '部分' : '完成', rea: rea ? '已分析' : '未取得', analysis: `${analysis.length} 条结论`, report: '已导出' }, assets: assets.length, directory, extractedScripts: sources.length, inlineScripts: inventory.scripts.length,
      findings: topics.flatMap(t => analysis.filter(r => r.topic === t).slice(0, 2)),
      warnings, artifacts: artifacts.filter(a => a.type !== 'image').map(a => ({ id: a.id, name: a.name })) } } };
  },
};
function message(error: unknown) { return (error instanceof Error ? error.message : String(error)).slice(0, 400); }
