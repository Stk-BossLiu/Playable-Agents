import type { GraphNodeTypeInfo } from '../../../shared/graph';
import type { NodeDefinition, NodeTypeDescriptor } from './types';

export class NodeRegistry {
  private readonly definitions = new Map<string, NodeDefinition>();

  register(definition: NodeDefinition): this {
    if (!definition.type?.trim()) throw new Error('Node type is required');
    if (this.definitions.has(definition.type)) {
      throw new Error(`Node type already registered: ${definition.type}`);
    }
    this.definitions.set(definition.type, definition);
    return this;
  }

  registerAll(definitions: NodeDefinition[]): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  get(type: string): NodeDefinition | undefined {
    return this.definitions.get(type);
  }

  has(type: string): boolean {
    return this.definitions.has(type);
  }

  list(): NodeTypeDescriptor[] {
    return [...this.definitions.values()]
      .map((definition) => this.describe(definition))
      .sort((a, b) => a.category.localeCompare(b.category) || a.type.localeCompare(b.type));
  }

  catalog(): Record<string, GraphNodeTypeInfo> {
    const catalog: Record<string, GraphNodeTypeInfo> = {};
    for (const definition of this.definitions.values()) {
      catalog[definition.type] = {
        type: definition.type,
        category: definition.category,
        inputs: definition.inputs,
        outputs: definition.outputs,
      };
    }
    return catalog;
  }

  get size(): number {
    return this.definitions.size;
  }

  private describe(definition: NodeDefinition): NodeTypeDescriptor {
    return {
      type: definition.type,
      category: definition.category,
      label: definition.label,
      description: definition.description,
      inputs: definition.inputs,
      outputs: definition.outputs,
      paramsSchema: definition.paramsSchema,
      ...(definition.uiSchema ? { uiSchema: definition.uiSchema } : {}),
      ...(definition.requires ? { requires: definition.requires } : {}),
    };
  }
}
