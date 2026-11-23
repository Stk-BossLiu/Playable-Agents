import type { ToolResult } from './result';

export type ToolRisk = 'read' | 'write' | 'destroy';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolContext {
  bridgeUrl: string;
  toolCount: number;
}

export interface ToolRequirements {
  scene?: boolean;
  assetDb?: boolean;
  programming?: boolean;
}

export type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
};

export interface ToolDef {
  name: string;
  label?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  risk: ToolRisk;
  /** 跳过编辑器就绪门禁（如 editor_get_state 本身）。 */
  skipGate?: boolean;
  /** 该工具要求的编辑器就绪项；默认 scene + asset-db。 */
  requires?: ToolRequirements;
  /** 审批条上的人类可读摘要。 */
  approvalSummary?: (args: Record<string, unknown>) => string;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export function defineTool(def: ToolDef): ToolDef {
  return def;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();
  private disabled = new Set<string>();

  register(tool: ToolDef): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: ToolDef[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  setDisabled(names: string[]): void {
    this.disabled = new Set(names.filter(Boolean));
  }

  getDisabled(): string[] {
    return [...this.disabled];
  }

  isDisabled(name: string): boolean {
    return this.disabled.has(name);
  }

  getSchemas(): ToolSchema[] {
    return this.list()
      .filter((tool) => !this.disabled.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: normalizeAnnotations(tool),
      }));
  }

  async call(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        error: { code: 'TOOL_NOT_FOUND', message: `未知工具：${name}`, hint: '重新 tools/list 获取当前工具列表。' },
      };
    }
    if (this.disabled.has(name)) {
      return {
        ok: false,
        error: { code: 'TOOL_DISABLED', message: `工具已禁用：${name}`, hint: '在工具设置中启用后重试。' },
      };
    }
    return tool.handler(args ?? {}, ctx);
  }
}

function normalizeAnnotations(tool: ToolDef): ToolAnnotations {
  const base = tool.annotations ?? {};
  if (tool.risk === 'read') return { readOnlyHint: true, ...base };
  if (tool.risk === 'destroy') return { destructiveHint: true, ...base };
  return { ...base };
}
