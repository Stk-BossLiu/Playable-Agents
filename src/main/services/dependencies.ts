import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DependencyItem, DependenciesDTO } from '../../shared/dependencies';
import type { ModelProfileView } from '../../shared/models';
import { requestWithTimeout } from '../utils/ipc-editor';
import { readJson } from '../utils/fs';
import type { AgentRuntime } from './agent';

/**
 * Agent 状态页依赖检测：Pi / 桥 / ffmpeg / REA / 模型 / 编辑器 / 构建。
 * 不启动 Pi，不执行用户代码；缺失项只返回可操作提示。
 */
export class DependencyService {
  constructor(private readonly runtime: AgentRuntime) {}

  async check(): Promise<DependenciesDTO> {
    const [ffmpeg, rea, editor, builder] = await Promise.all([
      checkFfmpeg(),
      checkRea(),
      checkEditor(),
      checkBuilder(),
    ]);
    const items: DependencyItem[] = [];
    const binary = await this.runtime.resolveBinary().catch(() => null);
    items.push(
      binary
        ? {
            id: 'pi',
            label: 'Pi 二进制',
            required: true,
            state: 'ready',
            version: binary.version,
            path: binary.path,
          }
        : {
            id: 'pi',
            label: 'Pi 二进制',
            required: true,
            state: 'missing',
            message: '未找到 Pi；Agent 节点无法运行。',
            action: '在设置中下载 Pi 或选择路径',
          },
    );

    const bridgeUrl = this.runtime.bridge.getUrl();
    items.push(
      this.runtime.bridge.isRunning() && bridgeUrl
        ? {
            id: 'bridge',
            label: '本插件 MCP 桥',
            required: true,
            state: 'ready',
            path: bridgeUrl,
          }
        : {
            id: 'bridge',
            label: '本插件 MCP 桥',
            required: true,
            state: 'error',
            message: 'BridgeServer 未运行。',
            action: '重载扩展或重启 agent',
          },
    );

    items.push(ffmpeg, editor, builder);

    const models = this.runtime.models.getDTO();
    const defaultProfile = models.profiles.find((profile) => profile.id === models.defaultProfileId) ?? models.profiles[0];
    items.push(modelDependency('model-default', '默认模型', defaultProfile, true, models.piModelsPath));
    const visionProfile = models.profiles.find((profile) => profile.id === models.visionProfileId);
    items.push(
      visionProfile
        ? modelDependency('model-vision', '视觉模型', visionProfile, false, models.piModelsPath)
        : {
            id: 'model-vision',
            label: '视觉模型',
            required: false,
            state: 'optional',
            message: '未单独配置视觉 profile；agent.vision 会回退默认模型。',
            action: '在 Agent 状态页配置视觉模型',
          },
    );

    items.push(rea);
    items.push({
      id: 'cocos-mcp',
      label: 'cocos-mcp 扩展',
      required: false,
      state: 'not-required',
      message: '生产不依赖；本插件自带 BridgeServer。',
    });

    return { checkedAt: new Date().toISOString(), items };
  }
}

function modelDependency(
  id: string,
  label: string,
  profile: ModelProfileView | undefined,
  required: boolean,
  modelsPath: string,
): DependencyItem {
  if (!profile) {
    return {
      id,
      label,
      required,
      state: 'missing',
      message: '未配置模型 profile。',
      action: '填写 baseURL + secret + modelId 并校验',
    };
  }
  if (!profile.secretConfigured) {
    return {
      id,
      label,
      required,
      state: 'not-configured',
      version: profile.modelId,
      message: `profile ${profile.name} 未配置 secret。`,
      action: '在 Agent 状态页填写 secret',
    };
  }
  if (profile.lastValidation?.ok) {
    return {
      id,
      label,
      required,
      state: 'ready',
      version: profile.modelId,
      path: modelsPath,
      ...(profile.lastValidation.latencyMs !== undefined
        ? { message: `校验通过，${profile.lastValidation.latencyMs}ms` }
        : {}),
    };
  }
  return {
    id,
    label,
    required,
    state: profile.lastValidation ? 'error' : 'not-configured',
    version: profile.modelId,
    message: profile.lastValidation?.error ?? '尚未校验；Pi 可能无法使用该模型。',
    action: '点击校验',
  };
}

async function checkFfmpeg(): Promise<DependencyItem> {
  const binary = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  try {
    const version = await new Promise<string>((resolve, reject) => {
      execFile(binary, ['-version'], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout));
      });
    });
    const match = version.match(/ffmpeg version\s+([^\s]+)/i);
    return {
      id: 'ffmpeg',
      label: 'ffmpeg',
      required: false,
      state: 'ready',
      ...(match ? { version: match[1] } : {}),
      path: binary,
    };
  } catch {
    return {
      id: 'ffmpeg',
      label: 'ffmpeg',
      required: false,
      state: 'missing',
      message: '未找到 ffmpeg；视频截帧节点不可用。',
      action: '安装 ffmpeg 或设置 FFMPEG_PATH',
    };
  }
}

async function checkRea(): Promise<DependencyItem> {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');
  const config = await readJson<{ mcpServers?: Record<string, unknown> }>(join(agentDir, 'mcp.json'));
  const configured = Boolean(config?.mcpServers && 'rea' in config.mcpServers);
  return {
    id: 'rea',
    label: 'REA 逆向（可选）',
    required: false,
    state: configured ? 'ready' : 'optional',
    ...(configured
      ? { message: '检测到 rea MCP 配置。' }
      : { message: '未配置 REA；参考试玩逆向节点会跳过。', action: '如需要，在 MCP 设置中添加 REA' }),
  };
}

async function checkEditor(): Promise<DependencyItem> {
  try {
    const [sceneReady, assetReady] = await Promise.all([
      requestWithTimeout<boolean>('scene', 'query-is-ready', [], 3_000).catch(() => false),
      requestWithTimeout<boolean>('asset-db', 'query-ready', [], 3_000).catch(() => false),
    ]);
    if (sceneReady && assetReady) {
      return { id: 'editor', label: '编辑器 scene / asset-db', required: false, state: 'ready' };
    }
    return {
      id: 'editor',
      label: '编辑器 scene / asset-db',
      required: false,
      state: 'error',
      message: `scene=${sceneReady ? 'ready' : 'busy'}，asset-db=${assetReady ? 'ready' : 'busy'}。`,
      action: '等待场景/资源加载完成',
    };
  } catch {
    return {
      id: 'editor',
      label: '编辑器 scene / asset-db',
      required: false,
      state: 'error',
      message: '就绪状态查询失败。',
    };
  }
}

async function checkBuilder(): Promise<DependencyItem> {
  try {
    const ready = await requestWithTimeout<boolean>('builder', 'query-worker-ready', [], 3_000);
    return {
      id: 'builder',
      label: '构建服务',
      required: false,
      state: ready ? 'ready' : 'error',
      ...(ready ? {} : { message: '构建 worker 未就绪。', action: '打开构建面板后重试' }),
    };
  } catch {
    return {
      id: 'builder',
      label: '构建服务',
      required: false,
      state: 'optional',
      message: '未检测到 builder 构建服务；打包构建图暂不可用。',
    };
  }
}
