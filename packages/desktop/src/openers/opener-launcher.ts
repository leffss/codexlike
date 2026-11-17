import type { ResolvedOpener } from "./opener-resolver";

/**
 * 工作区打开器启动器：explorer 走 Electron shell.openPath（跟随系统文件
 * 管理器，跨平台兜底），编辑器 exe 走 detach spawn（不等待、不接管道、
 * windowsHide），终端打开器按探测的启动风格换 spawn 形参——wt 以 `-d`
 * 显式起始目录（wt 不继承 spawn cwd），其余 shell 继承 cwd 起交互会话。
 * 每次调用都是独立进程：终端多开即多点几次。依赖注入 openPath /
 * spawnProcess，主进程装配处绑定真实 electron shell 与 child_process.spawn。
 */

export interface OpenerLaunchDeps {
  /** electron shell.openPath：成功返回空串，失败返回错误消息 */
  openPath(path: string): Promise<string>;
  /**
   * spawn 包装：须以 detached + stdio ignore 启动；返回可订阅 spawn/error 的句柄。
   * options 透传子进程选项：cwd（终端起始目录）与 windowsHide（终端打开器
   * 传 false——控制台程序被 hide 会起进程无窗口，见下方终端分支注释）。
   */
  spawnProcess(
    command: string,
    args: string[],
    options?: { cwd?: string; windowsHide?: boolean }
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
    if (opener.terminalStyle === undefined) {
      // 编辑器：工作区路径作首参（Code.exe <path> 惯例）
      const child = deps.spawnProcess(opener.exePath, [workspacePath]);
      child.unref();
      await settle(child, opener.exePath);
      return;
    }
    // 终端：起始目录经 -d（wt 不继承 spawn cwd）或 cwd 继承（bash/
    // powershell/cmd）传入；工作区路径不进位置参数——bash/powershell
    // 会把它当脚本/命令执行。windowsHide 必须 false：控制台程序被 hide
    // 会起进程无窗口（wt 是 GUI 程序不受影响，统一传省一层判别）
    const args = opener.terminalStyle === "wt" ? ["-d", workspacePath] : [];
    const child = deps.spawnProcess(opener.exePath, args, {
      ...(opener.terminalStyle === "inherit-cwd" ? { cwd: workspacePath } : {}),
      windowsHide: false,
    });
    child.unref();
    await settle(child, opener.exePath);
  };
}

/** spawn 结果等结算：spawn 即成功，error 拒绝并带 exe 路径 */
function settle(
  child: ReturnType<OpenerLaunchDeps["spawnProcess"]>,
  exePath: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      reject(new Error(`启动 ${exePath} 失败：${error.message}`));
    });
    child.once("spawn", () => resolve());
  });
}
