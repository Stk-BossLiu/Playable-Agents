import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_NAME } from '../../shared/protocol';

export interface DiagnosticState {
  loadAt?: string;
  unloadAt?: string;
  panelReadyAt?: string;
  panelReadyPayload?: unknown;
  lastError?: string;
  [key: string]: unknown;
}

function stateFile(): string {
  return join(Editor.Project.path, '.dev', 'cocos-ai-agent', 'phase0-state.json');
}

/** 轻量诊断快照；后续诊断页可在此扩展 stderr/协议日志。 */
export function writeDiagnostic(patch: Partial<DiagnosticState>): void {
  try {
    const file = stateFile();
    mkdirSync(join(Editor.Project.path, '.dev', 'cocos-ai-agent'), { recursive: true });
    let current: DiagnosticState = {};
    try {
      current = JSON.parse(readFileSync(file, 'utf8')) as DiagnosticState;
    } catch {
      current = {};
    }
    writeFileSync(
      file,
      `${JSON.stringify({ ...current, ...patch, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
  } catch (error) {
    console.warn(`[${PACKAGE_NAME}] write diagnostic failed`, error);
  }
}

export function readDiagnostic(): DiagnosticState {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8')) as DiagnosticState;
  } catch {
    return {};
  }
}
