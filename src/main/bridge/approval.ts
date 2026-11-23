import { randomUUID } from 'node:crypto';
import type { PanelEvent } from '../../shared/types';
import type { ToolDef } from './schema';

export type ApprovalReason = 'denied' | 'timeout';

export interface ApprovalResult {
  approved: boolean;
  reason?: ApprovalReason;
}

interface PendingApproval {
  tool: string;
  resolve: (result: ApprovalResult) => void;
  timer: NodeJS.Timeout;
}

export interface ApprovalManagerOptions {
  send: (event: PanelEvent) => void;
  getConfirmMode: () => 'always' | 'destructive' | 'never';
  getWhenPanelClosed: () => 'deny' | 'allow';
  isPanelOpen: () => boolean;
  timeoutMs?: number;
}

/**
 * 危险操作审批：挂起 MCP/图节点调用，向面板发 approval-request，等待 approval-respond。
 * 超时/面板关闭按策略拒绝，避免永久挂起。
 */
export class ApprovalManager {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly approvedTools = new Set<string>();
  private readonly timeoutMs: number;

  constructor(private readonly options: ApprovalManagerOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  needsApproval(tool: ToolDef): boolean {
    if (tool.risk === 'read') return false;
    if (this.approvedTools.has(tool.name)) return false;
    const mode = this.options.getConfirmMode();
    if (mode === 'never') return false;
    if (mode === 'always') return true;
    return tool.risk === 'destroy';
  }

  async request(tool: ToolDef, args: Record<string, unknown>): Promise<ApprovalResult> {
    if (!this.needsApproval(tool)) return { approved: true };

    if (!this.options.isPanelOpen()) {
      if (this.options.getWhenPanelClosed() === 'allow') return { approved: true };
      return { approved: false, reason: 'denied' };
    }

    const id = randomUUID();
    const summary = tool.approvalSummary?.(args) ?? defaultSummary(tool.name, args);
    const argsPreview = safePreview(args);

    this.options.send({
      type: 'approval-request',
      payload: {
        id,
        tool: tool.name,
        summary,
        risk: tool.risk,
        argsPreview,
        timeoutMs: this.timeoutMs,
        requestedAt: Date.now(),
      },
    });

    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.options.send({ type: 'approval-resolved', payload: { id, approved: false, reason: 'timeout' } });
        resolve({ approved: false, reason: 'timeout' });
      }, this.timeoutMs);
      this.pending.set(id, { tool: tool.name, resolve, timer });
    });
  }

  respond(id: string, approved: boolean, always = false): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (approved && always) this.approvedTools.add(entry.tool);
    this.options.send({ type: 'approval-resolved', payload: { id, approved } });
    entry.resolve({ approved, ...(approved ? {} : { reason: 'denied' as const }) });
    return true;
  }

  cancelAll(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ approved: false, reason: 'denied' });
      this.options.send({ type: 'approval-resolved', payload: { id, approved: false, reason: 'denied' } });
    }
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

function defaultSummary(toolName: string, args: Record<string, unknown>): string {
  const target =
    stringArg(args, 'url') ||
    stringArg(args, 'path') ||
    stringArg(args, 'uuid') ||
    stringArg(args, 'name') ||
    '';
  return target ? `${toolName}：${target}` : toolName;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function safePreview(args: Record<string, unknown>): string {
  try {
    const text = JSON.stringify(args);
    return text.length > 800 ? `${text.slice(0, 800)}…` : text;
  } catch {
    return '[unserializable args]';
  }
}
