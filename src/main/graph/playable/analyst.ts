import { PLAYABLE_AGENT_TYPE, PLAYABLE_SYSTEM_PROMPT } from '../../../shared/playable';
import type { NodeDefinition, NodeRunContext } from '../nodes/types';

export const topics = ['资源', '玩法', '设计逻辑', '项目架构'] as const;
type Topic = typeof topics[number];
export interface Finding { topic: Topic; text: string; refs: string[] }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const reverseModelParams = {
  provider: { type: 'string', description: '试玩逆向 Agent 提供商' },
  model: { type: 'string', description: '试玩逆向 Agent 模型' },
} as const;

export async function analyzeEvidence(ctx: NodeRunContext, evidence: unknown): Promise<Finding[]> {
  if (!record(evidence)) throw new Error('请连接包含编号的试玩证据对象');
  const ids = new Set<string>();
  for (const key of ['assets', 'scripts', 'clues']) {
    const items = evidence[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) if (record(item) && typeof item.id === 'string') ids.add(item.id);
  }
  if (evidence.R1) ids.add('R1');
  if (!ids.size) return [];
  const { provider, model, modelProfileId, prompt } = ctx.params;
  if (Boolean(provider) !== Boolean(model)) throw new Error('请同时选择逆向提供商和模型');
  const result = await ctx.agent({
    systemPrompt: PLAYABLE_SYSTEM_PROMPT,
    prompt: JSON.stringify({ focus: typeof prompt === 'string' ? prompt.slice(0, 800) : '', evidence }),
    ...(typeof provider === 'string' && typeof model === 'string' ? { provider, model } : {}),
    ...(typeof modelProfileId === 'string' ? { modelProfileId } : {}),
  });
  const rows: unknown = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (!Array.isArray(rows)) throw new Error('逆向 Agent 应返回 JSON 数组');
  return rows.filter((row): row is Finding => record(row) && topics.some(t => t === row.topic)
    && typeof row.text === 'string' && row.text.trim().length > 0 && row.text.length <= 500
    && Array.isArray(row.refs) && row.refs.length > 0 && row.refs.length <= 8
    && row.refs.every((id: unknown) => typeof id === 'string' && ids.has(id))).slice(0, 40);
}

export const playableAgentNode: NodeDefinition = {
  type: PLAYABLE_AGENT_TYPE, category: 'agent', label: '试玩逆向 Agent',
  description: '从带编号的资源、脚本和静态线索中提取可核对的结论。',
  inputs: [{ name: 'evidence', type: 'json', required: true, description: '含 assets、scripts、clues 编号记录或 R1 摘要的对象' }],
  outputs: [{ name: 'json', type: 'json', required: true }],
  paramsSchema: { type: 'object', properties: { ...reverseModelParams, prompt: { type: 'string', description: '分析侧重点' } } },
  async run(ctx) {
    return { outputs: { json: await analyzeEvidence(ctx, ctx.inputs.evidence) } };
  },
};
