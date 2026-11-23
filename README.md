# Cocos AI Agent

Cocos Creator 3.8.x 的 AI 智能体扩展：节点工作流画板 + Pi Agent + 编辑器控制工具，面向 H5/Web 试玩开发。

> 当前开发阶段：Phase 4 核心（三面板、基础画板、图引擎、Agent/工具节点、内置 `试玩开发计划`、模型凭证）已完成；产物预览/模板导入导出/运行控制细节按 `docs/plan` 后续补齐。

## 运行时依赖（重要）

| 组件 | 是否必须 | 说明 |
|---|---|---|
| `cocos-ai-agent` 扩展 | **必须** | 只安装这一个编辑器扩展 |
| Pi 二进制 | **必须** | 首次使用时自动下载/校验；也可配置系统 PATH 中的 `pi` 或自定义路径 |
| ffmpeg | 可选 | 只有“视频截帧”节点需要 |
| REA | 可选 | 只有“参考试玩逆向”节点需要 |
| `cocos-mcp` | **不需要** | 生产环境不依赖；本插件自带本地 MCP BridgeServer |
| 其它 MCP 插件/服务 | **不需要** | 不依赖外部 MCP server |

### 为什么不需要单独装 cocos-mcp

- `cocos-ai-agent` 在自己的主进程里启动一个**本地 MCP BridgeServer**（只绑 `127.0.0.1`，随机端口），仅用于 Pi 子进程调用编辑器工具。
- 图引擎/工具节点在编辑器主进程内**直接调用 `Editor.Message`**，不经过 MCP。
- Pi 是独立子进程（自带 Node 运行时），无法直接访问编辑器的 `Editor.Message`，所以需要 MCP 这层跨进程桥；这层桥由本扩展自带，不是 `cocos-mcp` 插件。
- 当前开发工程里的 `cocos-mcp` 只是开发期辅助（热重载/日志/测试），生产可禁用或删除。

## 安装

1. 将 `cocos-ai-agent` 解压到：
   - `<project>/extensions/cocos-ai-agent/`（项目级），或
   - `~/.CocosCreator/extensions/cocos-ai-agent/`（全局）。
2. 打开 Cocos Creator 3.8.5+ 工程；扩展加载后菜单出现入口：
   - `开发者 -> 打开 Cocos AI Agent`
   - 面板内提供“画板 / 对话 / Agent 状态”三个视图，默认停靠在属性检查器旁。
3. 首次使用：
   - 打开面板/设置，下载 Pi 二进制（约 40MB，带 SHA256 校验），或选择已有的 `pi` 路径；
   - 在 **Agent 状态** 页配置模型：`baseURL + secret + modelId`，点击“校验”；
   - 校验通过后启动 Agent。

## 模型配置

- 主字段：`baseURL`、`secret`、`modelId` + `校验`。
- 高级字段：`apiType`（默认 `openai-completions`）、`vision`、`contextWindow`、`maxTokens`、`reasoning`。
- `maxTokens` 上限为 1,000,000（可按模型实际能力填写，例如 384000）；`contextWindow` 上限 4,000,000。
- 校验：
  - `GET {baseURL}/models` + Bearer secret，检查模型是否存在；
  - 不支持时回退 `POST {baseURL}/chat/completions` 的 1-token 请求；
  - 返回延迟、模型列表、错误/警告。
- 保存：
  - `secret` 存编辑器 global profile，不写项目文件、不写日志；
  - 生成/合并 `<agent-dir>/models.json`（默认 `~/.pi/agent/models.json`，支持 `PI_CODING_AGENT_DIR`），`apiKey` 用 `$COCOS_AI_AGENT_MODEL_KEY_*` 环境变量引用；
  - 启动 Pi 时注入 secret，并传 `--provider/--model`。
- 未配置模型时回退 Pi 登录态/默认模型（`pi /login`）。
- 视觉模型可选；未配置时视觉节点用默认模型，默认模型不支持图片会给出明确错误。

## 目录与架构（简版）

```
cocos-ai-agent/
├── package.json
├── dist/                 # main / panel(s) / scene-script / cocos-tools
├── resources/workflows/  # 内置工作流 JSON
├── i18n/                 # zh/en
└── README.md
```

- **main**：Editor.Message 工具、MCP BridgeServer、图引擎/节点注册表、Pi 进程/RPC、模型 profile、审批。
- **panel**：单一 `Cocos AI Agent` dockable panel，内部分为画板 / 对话 / Agent 状态三个视图；画板支持工作流列表、节点/连线编辑、平移缩放、检查器和运行日志。
- **agent/cocos-tools**：Pi 扩展（会话/状态/斜杠命令）。
- **resources/workflows**：内置 `空白工作流`、`试玩开发计划`；`计划实施`、`打包构建`、`性能检查` 按 Phase 5 增加。

## 已知限制（v0.2）

- 构建图首版只支持 H5/Web（`web-mobile`/`web-desktop`），不承诺微信小游戏/原生。
- 视频截帧依赖 ffmpeg；未安装时对应节点失败。
- REA 为可选外部 MCP；未安装时参考试玩逆向节点跳过。
- 视觉模型未配置时用默认模型；默认模型不支持图片会提示配置。
- 画板不支持用户编写任意 JS 节点（后续版本提供受信任节点 SDK）。
- 预览“停止”无编辑器消息；性能检查在 CDP 不可用时降级为日志/静态分析。

## 主题

- 颜色直接继承 Cocos 编辑器的 `--color-*` 变量（primary/success/danger/normal/default/active fill 等），不是独立调色板。
- 不使用 `prefers-color-scheme`；3.8.8 编辑器主题为 `creator` 深色，插件保持同色系，避免出现编辑器深色、插件浅色。
- 主青 `#40aaca`、成功青绿 `#64daaf`、危险红 `#d85f6f`、背景 `#141414/#2b2b2b/#3d3d3d` 为 3.8.8 实测 fallback。

## 安全

- secret 只存编辑器 global profile；`models.json` 只用环境变量引用；日志/事件不打印 secret。
- 工具调用受 `EditorStateGate`/`ApprovalManager` 约束；危险操作可配置为需用户确认。
- Agent 子进程与编辑器隔离；关闭编辑器时清理 pi 进程。
