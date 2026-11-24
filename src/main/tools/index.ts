import { queryConsole } from './console';
import { ToolRegistry } from '../bridge/schema';
import { assetTools } from './asset';
import { componentTools } from './component';
import { editorTools } from './editor';
import { nodeTools } from './node';
import { propertyTools } from './property';
import { sceneTools } from './scene';

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(sceneTools);
  registry.registerAll(nodeTools);
  registry.registerAll(componentTools);
  registry.registerAll(propertyTools);
  registry.registerAll(assetTools);
  registry.registerAll(editorTools);
  registry.register(queryConsole);
  return registry;
}
