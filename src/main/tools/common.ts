import type { JsonSchema, ToolDef, ToolRequirements, ToolRisk } from '../bridge/schema';
import { defineTool } from '../bridge/schema';
import { fail, ok, type ToolResult } from '../bridge/result';

export { fail, ok, type ToolResult };

export interface EditorToolOptions {
  name: string;
  label?: string;
  description: string;
  inputSchema: JsonSchema;
  risk: ToolRisk;
  requires?: ToolRequirements;
  skipGate?: boolean;
  approvalSummary?: (args: Record<string, unknown>) => string;
  handler: ToolDef['handler'];
}

export function editorTool(options: EditorToolOptions): ToolDef {
  return defineTool({
    name: options.name,
    label: options.label,
    description: options.description,
    inputSchema: options.inputSchema,
    risk: options.risk,
    requires: options.requires,
    skipGate: options.skipGate,
    approvalSummary: options.approvalSummary,
    handler: options.handler,
  });
}

export function strArg(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

export function numArg(args: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

export function boolArg(args: Record<string, unknown>, ...names: string[]): boolean | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

export function objectArg(args: Record<string, unknown>, ...names: string[]): Record<string, unknown> | undefined {
  for (const name of names) {
    const value = args[name];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return undefined;
}

export function arrayArg(args: Record<string, unknown>, ...names: string[]): unknown[] | undefined {
  for (const name of names) {
    const value = args[name];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

export function uuidArg(args: Record<string, unknown>): string | undefined {
  return strArg(args, 'uuid', 'node', 'nodeUuid');
}

export function requireString(
  args: Record<string, unknown>,
  names: string[],
  message: string,
): { value: string } | { error: ToolResult } {
  const value = strArg(args, ...names);
  if (!value) return { error: fail('INVALID_ARGS', message) };
  return { value };
}

export function parseUuidList(args: Record<string, unknown>, ...names: string[]): string[] {
  const single = strArg(args, ...names);
  if (single) return [single];
  const list = arrayArg(args, ...names);
  if (list) return list.filter((item): item is string => typeof item === 'string');
  return [];
}

export function truncate(text: string, max = 200_000): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/** 把普通 JS 值转成 Cocos scene dump；显式 dump 直接透传。 */
export function toDump(value: unknown, type?: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.__type__ && 'value' in record) return record;
    if (typeof record.type === 'string' && 'value' in record) return record;
  }
  if (Array.isArray(value)) {
    return {
      isArray: true,
      value: value.map((item) => toDump(item) ?? { type: 'String', value: String(item) }),
    };
  }
  switch (type) {
    case 'number':
    case 'Number':
      return { type: 'Number', value: Number(value) };
    case 'boolean':
    case 'Boolean':
      return { type: 'Boolean', value: Boolean(value) };
    case 'string':
    case 'String':
      return { type: 'String', value: String(value) };
    case 'enum':
    case 'Enum':
      return { type: 'Enum', value: Number(value) };
    case 'vec3':
    case 'cc.Vec3': {
      const record = value as { x?: number; y?: number; z?: number };
      return {
        type: 'cc.Vec3',
        value: { x: Number(record?.x ?? 0), y: Number(record?.y ?? 0), z: Number(record?.z ?? 0) },
      };
    }
    case 'vec2':
    case 'cc.Vec2': {
      const record = value as { x?: number; y?: number };
      return { type: 'cc.Vec2', value: { x: Number(record?.x ?? 0), y: Number(record?.y ?? 0) } };
    }
    case 'size':
    case 'cc.Size': {
      const record = value as { width?: number; height?: number };
      return {
        type: 'cc.Size',
        value: { width: Number(record?.width ?? 0), height: Number(record?.height ?? 0) },
      };
    }
    case 'color':
    case 'cc.Color': {
      const record = value as { r?: number; g?: number; b?: number; a?: number };
      return {
        type: 'cc.Color',
        value: { r: Number(record?.r ?? 255), g: Number(record?.g ?? 255), b: Number(record?.b ?? 255), a: Number(record?.a ?? 255) },
      };
    }
    case 'node':
    case 'cc.Node':
      if (value && typeof value === 'object' && 'uuid' in value) {
        return { type: 'cc.Node', value: { uuid: String((value as { uuid: unknown }).uuid) } };
      }
      return { type: 'cc.Node', value: { uuid: String(value) } };
    default:
      break;
  }
  if (value && typeof value === 'object' && 'x' in value && 'y' in value && 'z' in value) {
    const record = value as { x: number; y: number; z: number };
    return { type: 'cc.Vec3', value: { x: record.x, y: record.y, z: record.z } };
  }
  if (value && typeof value === 'object' && 'x' in value && 'y' in value) {
    const record = value as { x: number; y: number };
    return { type: 'cc.Vec2', value: { x: record.x, y: record.y } };
  }
  if (value && typeof value === 'object' && 'width' in value && 'height' in value) {
    const record = value as { width: number; height: number };
    return { type: 'cc.Size', value: { width: record.width, height: record.height } };
  }
  if (value && typeof value === 'object' && 'r' in value && 'g' in value && 'b' in value) {
    const record = value as { r: number; g: number; b: number; a?: number };
    return { type: 'cc.Color', value: { r: record.r, g: record.g, b: record.b, a: record.a ?? 255 } };
  }
  if (typeof value === 'boolean') return { type: 'Boolean', value };
  if (typeof value === 'number') return { type: 'Number', value };
  return { type: 'String', value: String(value) };
}

export async function queryNodeDump(
  request: <T>(target: string, message: string, ...args: unknown[]) => Promise<T>,
  nodeUuid: string,
): Promise<Record<string, any> | null> {
  const dump = await request<Record<string, any> | null>('scene', 'query-node', nodeUuid);
  return dump ?? null;
}

export function componentIndexFromDump(
  dump: Record<string, any> | null,
  selector: string | number | undefined,
): number {
  if (!dump) return -1;
  const comps = Array.isArray(dump.__comps__) ? dump.__comps__ : [];
  if (selector === undefined || selector === '') return 0;
  if (typeof selector === 'number') return selector;
  const text = String(selector);
  if (/^\d+$/.test(text)) return Number(text);
  return comps.findIndex((comp: any) => {
    const value = comp?.value ?? {};
    return (
      value.uuid === text ||
      value.name === text ||
      value.cid === text ||
      comp?.type === text ||
      comp?.cid === text
    );
  });
}

export function summarizeScene(scene: Record<string, any> | null): Record<string, unknown> {
  if (!scene) return { ready: false };
  return {
    uuid: scene.uuid ?? null,
    name: scene.name ?? null,
    url: scene.url ?? null,
    dirty: scene.dirty ?? null,
    mode: scene.mode ?? null,
  };
}
