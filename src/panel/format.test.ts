import { describe, expect, it } from 'vitest';
import { formatJsonText, formatJsonValue } from './format';

describe('tool JSON formatting', () => {
  it('pretty-prints JSON strings', () => {
    expect(formatJsonText('{"name":"node","args":{"x":1}}')).toBe(
      '{\n  "name": "node",\n  "args": {\n    "x": 1\n  }\n}',
    );
  });

  it('pretty-prints object values', () => {
    expect(formatJsonValue({ name: 'node', count: 2 })).toContain('"name": "node"');
  });

  it('leaves non-JSON text untouched', () => {
    expect(formatJsonText('created node')).toBe('created node');
  });
});
