import { requestWithTimeout } from '../utils/ipc-editor';
import type { ToolRequirements } from './schema';

export interface GateResult {
  ready: boolean;
  blockingReasons: string[];
  retryAfterMs: number;
  sceneReady: boolean;
  assetDbReady: boolean;
  programmingReady: boolean;
}

/**
 * 编辑器就绪门禁。scene 面板未就绪时所有 scene 消息会返回 null，
 * 因此写操作前必须检查；读操作也可配置检查，避免模型拿到空数据。
 */
export class EditorStateGate {
  private cached: { at: number; key: string; result: GateResult } | null = null;

  async check(requires: ToolRequirements = { scene: true, assetDb: true }, timeoutMs = 5_000): Promise<GateResult> {
    const key = `${requires.scene !== false}|${requires.assetDb !== false}|${requires.programming === true}`;
    const now = Date.now();
    if (this.cached && this.cached.key === key && now - this.cached.at < 300) {
      return this.cached.result;
    }

    const [sceneReady, assetReady, programmingReady] = await Promise.all([
      requires.scene === false
        ? Promise.resolve(true)
        : queryBoolean('scene', 'query-is-ready', timeoutMs),
      requires.assetDb === false
        ? Promise.resolve(true)
        : queryBoolean('asset-db', 'query-ready', timeoutMs),
      requires.programming
        ? requestWithTimeout<boolean>('programming', 'packer-driver/ready', ['editor'], timeoutMs).catch(() => false)
        : Promise.resolve(true),
    ]);

    const blockingReasons: string[] = [];
    if (!sceneReady) blockingReasons.push('scene 未就绪');
    if (!assetReady) blockingReasons.push('asset-db 未就绪');
    if (!programmingReady) blockingReasons.push('编译服务未就绪');

    const result: GateResult = {
      ready: blockingReasons.length === 0,
      blockingReasons,
      retryAfterMs: blockingReasons.length ? 800 : 0,
      sceneReady,
      assetDbReady: assetReady,
      programmingReady,
    };
    this.cached = { at: now, key, result };
    return result;
  }
}

async function queryBoolean(target: string, message: string, timeoutMs: number): Promise<boolean> {
  try {
    return Boolean(await requestWithTimeout<boolean>(target, message, [], timeoutMs));
  } catch {
    return false;
  }
}
