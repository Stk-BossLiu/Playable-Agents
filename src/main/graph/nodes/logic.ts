import type { NodeDefinition } from './types';

export const logicNodes: NodeDefinition[] = [
  {
    type: 'logic.merge',
    category: 'logic',
    label: '合并',
    description: '把多条上游数据合并为一个值；支持文本拼接、JSON 合并或数组。',
    inputs: [{ name: 'values', type: 'any', required: false, multiple: true, description: '待合并的值' }],
    outputs: [{ name: 'value', type: 'any', required: true }],
    paramsSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['auto', 'text', 'json', 'array'],
          description: '合并方式，默认 auto',
        },
        separator: { type: 'string', description: '文本模式分隔符，默认换行' },
      },
      additionalProperties: true,
    },
    async run(ctx) {
      const values = Array.isArray(ctx.inputs.values) ? ctx.inputs.values : [];
      const mode = typeof ctx.params.mode === 'string' ? ctx.params.mode : 'auto';
      const separator = typeof ctx.params.separator === 'string' ? ctx.params.separator : '\n';
      let value: unknown;
      if (mode === 'array') {
        value = values;
      } else if (mode === 'json') {
        value = values.reduce<Record<string, unknown>>((acc, item) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            return { ...acc, ...(item as Record<string, unknown>) };
          }
          return acc;
        }, {});
      } else if (mode === 'text' || values.every((item) => typeof item === 'string')) {
        value = values.map(stringifyValue).join(separator);
      } else if (values.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
        value = values.reduce<Record<string, unknown>>((acc, item) => {
          return { ...acc, ...(item as Record<string, unknown>) };
        }, {});
      } else {
        value = values.length === 1 ? values[0] : values;
      }
      ctx.log('info', `合并 ${values.length} 个输入（${mode}）`);
      return { outputs: { value } };
    },
  },
  {
    type: 'logic.template',
    category: 'logic',
    label: '模板',
    description: '用 {{path}} 占位符把上游数据渲染成文本。',
    inputs: [{ name: 'data', type: 'any', required: false }],
    outputs: [{ name: 'text', type: 'text', required: true }],
    paramsSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: '模板文本，支持 {{field}} 与 {{nested.field}}' },
      },
      required: ['template'],
      additionalProperties: true,
    },
    uiSchema: { template: { control: 'textarea', rows: 8 } },
    async run(ctx) {
      const template = typeof ctx.params.template === 'string' ? ctx.params.template : '';
      if (!template) throw new Error('logic.template 缺少 params.template');
      const data = ctx.inputs.data;
      const text = template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path: string) => {
        if (path === 'json') return stringifyValue(data);
        if (path === 'value') return stringifyValue(data);
        const value = readPath(data, path);
        return value === undefined ? '' : stringifyValue(value);
      });
      return { outputs: { text } };
    },
  },
  {
    type: 'logic.map',
    category: 'logic',
    label: '映射',
    description: '对数组逐项读取字段；不执行任意脚本。',
    inputs: [{ name: 'items', type: 'any', required: true }],
    outputs: [{ name: 'items', type: 'any', required: true }],
    paramsSchema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: '每项要读取的字段路径；省略则原样返回' },
        keepObject: { type: 'boolean', description: '保留原对象并追加 field 值' },
      },
      additionalProperties: true,
    },
    async run(ctx) {
      const input = ctx.inputs.items;
      const items = Array.isArray(input) ? input : [input];
      const field = typeof ctx.params.field === 'string' ? ctx.params.field : '';
      const mapped = items.map((item) => {
        if (!field) return item;
        const value = readPath(item, field);
        if (ctx.params.keepObject && item && typeof item === 'object' && !Array.isArray(item)) {
          return { ...(item as Record<string, unknown>), value };
        }
        return value;
      });
      return { outputs: { items: mapped } };
    },
  },
  {
    type: 'logic.condition',
    category: 'logic',
    label: '条件',
    description: '按字段/操作符判断条件，输出原值、匹配布尔值与可选分支值。',
    inputs: [{ name: 'value', type: 'any', required: false }],
    outputs: [
      { name: 'value', type: 'any', required: true },
      { name: 'matched', type: 'json', required: true },
    ],
    paramsSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对输入的字段路径' },
        operator: {
          type: 'string',
          enum: ['truthy', 'falsy', 'equals', 'not-equals', 'contains'],
          description: '判断操作符',
        },
        expected: { description: 'equals/not-equals/contains 的比较值' },
      },
      additionalProperties: true,
    },
    async run(ctx) {
      const target = typeof ctx.params.path === 'string' && ctx.params.path ? readPath(ctx.inputs.value, ctx.params.path) : ctx.inputs.value;
      const operator = typeof ctx.params.operator === 'string' ? ctx.params.operator : 'truthy';
      const expected = ctx.params.expected;
      let matched = false;
      switch (operator) {
        case 'falsy':
          matched = !target;
          break;
        case 'equals':
          matched = target === expected;
          break;
        case 'not-equals':
          matched = target !== expected;
          break;
        case 'contains':
          matched =
            typeof target === 'string'
              ? target.includes(String(expected ?? ''))
              : Array.isArray(target)
                ? target.includes(expected)
                : false;
          break;
        default:
          matched = Boolean(target);
      }
      ctx.log('info', `条件 ${operator} => ${matched}`);
      return { outputs: { value: ctx.inputs.value, matched } };
    },
  },
];

function readPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
