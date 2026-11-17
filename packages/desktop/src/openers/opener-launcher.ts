import type { ResolvedOpener } from "./opener-resolver";

/**
 * 工作区打开器启动器：explorer 走 Electron shell.openPath（跟随系统文件
 * 管理器，跨平台兜底），编辑器 exe 走 detach spawn（不等待、不接管道、
 * windowsHide）。依赖注入 openPath / spawnProcess，主进程装配处绑定真实
 * electron shell 与 child_process.spawn。
 */

export interface OpenerLaunchDeps {
  /** electron shell.openPath：成功返回空串，失败返回错误消息 */
  openPath(path: string): Promise<string>;
  /** spawn 包装：须以 detached + stdio ignore 启动；返回可订阅 spawn/error 的句柄 */
  spawnProcess(
    command: string,
    args: string[]
  ): {
    once(event: "error", listener: (error: Error) => void): void;
    once(event: "spawn", listener: () => void): void;
    unref(): void;
  };
}

export function createOpenerLauncher(deps: OpenerLaunchDeps) {
  return async function launch(
    opener: ResolvedOpener,
    workspacePath: string
  ): Promise<void> {
    if (opener.exePath === null) {
      const error = await deps.openPath(workspacePath);
      if (error !== "") {
        throw new Error(`资源管理器打开失败：${error}`);
      }
      return;
    }
    const child = deps.spawnProcess(opener.exePath, [workspacePath]);
    child.unref();
    await new Promise<void>((resolve, reject) => {
      child.once("error", (error) => {
        reject(new Error(`启动 ${opener.exePath} 失败：${error.message}`));
      });
      child.once("spawn", () => resolve());
    });
  };
}
