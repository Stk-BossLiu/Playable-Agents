/**
 * 运行在 scene 进程（引擎侧）的脚本。
 * 粒子系统等引擎对象操作在后续阶段经 execute-scene-script 调用这里的方法。
 */
export const methods = {
  ping(): string {
    return 'pong';
  },
};
