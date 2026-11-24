import { NodeRegistry } from './registry';
import { playableAgentNode } from '../playable/analyst';
import { agentNodes } from './agent';
import { humanNodes } from './human';
import { logicNodes } from './logic';
import { mediaNodes } from './media';
import { outputNodes } from './output';
import { sourceNodes } from './source';

export function createNodeRegistry(): NodeRegistry {
  return new NodeRegistry()
    .registerAll(sourceNodes)
    .registerAll(logicNodes)
    .registerAll(outputNodes)
    .registerAll(agentNodes)
    .register(playableAgentNode)
    .registerAll(humanNodes)
    .registerAll(mediaNodes);
}

export { NodeRegistry } from './registry';
export type { NodeDefinition, NodeRunContext, NodeResult, NodeTypeDescriptor } from './types';
