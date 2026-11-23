import { join, resolve } from 'node:path';
import { PACKAGE_NAME } from '../../shared/protocol';

export const DEV_DIR_NAME = '.dev/cocos-ai-agent';

export function projectPath(): string {
  return Editor.Project.path;
}

export function devDir(...parts: string[]): string {
  return join(projectPath(), '.dev', 'cocos-ai-agent', ...parts);
}

export function getExtensionRoot(): string {
  try {
    if (typeof Editor !== 'undefined' && Editor.Package?.getPath) {
      const path = Editor.Package.getPath(PACKAGE_NAME);
      if (path) return path;
    }
  } catch {
    // ignore
  }
  return typeof __dirname === 'string' ? resolve(__dirname, '..') : process.cwd();
}
