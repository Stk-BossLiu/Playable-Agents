import type { ToolContext, ToolRegistry } from './schema';
import { fail, type ToolResult } from './result';
import type { EditorStateGate } from './state-gate';
import type { ApprovalManager } from './approval';

/**
 * 工具执行器：门禁 → 审批 → handler。
 * BridgeServer（Pi Agent）和后续图引擎/工具节点都走这里，保证同一套错误码与安全策略。
 */
export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly gate: EditorStateGate,
    private readonly approval: ApprovalManager,
  ) {}

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.registry.get(name);
    if (!tool) {
      return fail('TOOL_NOT_FOUND', `未知工具：${name}`, '重新 tools/list 获取当前工具列表。');
    }
    if (this.registry.isDisabled(name)) {
      return fail('TOOL_DISABLED', `工具已禁用：${name}`, '在工具设置中启用后重试。');
    }

    if (!tool.skipGate) {
      const gate = await this.gate.check(tool.requires ?? { scene: true, assetDb: true });
      if (!gate.ready) {
        return fail(
          'EDITOR_BUSY',
          `编辑器未就绪：${gate.blockingReasons.join('、')}`,
          `约 ${gate.retryAfterMs}ms 后重试；场景/资源加载完成后再调用。`,
          {
            blocking_reasons: gate.blockingReasons,
            retry_after_ms: gate.retryAfterMs,
            scene_ready: gate.sceneReady,
            asset_db_ready: gate.assetDbReady,
          },
        );
      }
    }

    if (this.approval.needsApproval(tool)) {
      const result = await this.approval.request(tool, args);
      if (!result.approved) {
        return fail(
          result.reason === 'timeout' ? 'APPROVAL_TIMEOUT' : 'APPROVAL_DENIED',
          result.reason === 'timeout' ? '审批等待超时，操作已拒绝。' : '用户拒绝了该操作。',
          '不要重复尝试同一危险操作；如确需执行，请让用户调整确认设置。',
        );
      }
    }

    try {
      return await tool.handler(args, ctx);
    } catch (error) {
      return fail('EDITOR_ERROR', error instanceof Error ? error.message : String(error));
    }
  }
}
