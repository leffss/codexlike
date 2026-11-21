import type { TerminalSessionManager } from "@codexlike/agent-core/node";

/**
 * 终端会话生命周期硬边的宿主侧组合件（ADR 0033 票07）。manager（宿主级注册表）
 * 不按本票范围改动，这里只用其公开接口组合出三个生命周期动作：
 * 存活计数（确认提示口径）、closeTaskSessions（归档先杀后归档）、
 * settleTerminalSessionsOnStartup（重启收尾）。
 */

/**
 * 任务清单内的存活（running）会话数：退出屏障「N 个终端会话将关闭」与
 * 归档确认卡「N 个终端会话仍在运行」共用的计数口径。taskIds 为现存任务
 * id 清单（调用方经 manager.list() 取）——归属已删除任务的孤儿会话不计入
 * 提示数（其事件本就无现场可挂，见 03 票未决口；应用退出时 killAll 照常
 * 清理，项目移除路径的会话收尾是待办口子）。
 */
export function aliveSessionCount(
  sessions: TerminalSessionManager,
  taskIds: readonly string[]
): number {
  let count = 0;
  for (const taskId of taskIds) {
    for (const record of sessions.sessionsFor(taskId)) {
      if (record.status === "running") count += 1;
    }
  }
  return count;
}

/**
 * 终止一个任务的全部存活会话并等待各自 exit（任务归档「先杀后归档」的
 * 第一步，ADR 0033「任务归档时若有存活会话则提示后关闭」）。等待 exit 的
 * 目的：terminal-exited 事件在归档写入前推进——任务记录尚未归档、执行现场
 * 完整，UI 自然收到会话退出呈现，闭合 03 票「任务移除后事件无现场静默丢弃」
 * 的未决口。等待结构照 manager.killAll 内部模式：订阅先于 kill（事件不丢）、
 * 逐个消账、兜底超时（端口实现异常不发 exit 时不阻塞归档；迟到的 exit 在
 * 归档后到达——归档不是移除，事件仍可挂现场）。无存活会话时立即返回。
 */
export function closeTaskSessions(
  sessions: TerminalSessionManager,
  taskId: string,
  options?: { timeoutMs?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 2_000;
  const alive = sessions
    .sessionsFor(taskId)
    .filter((record) => record.status === "running");
  if (alive.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const pending = new Set(alive.map((record) => record.sessionId));
    const unsubscribe = sessions.onEvent((event) => {
      if (event.kind !== "terminal-exited") return;
      pending.delete(event.record.sessionId);
      if (pending.size === 0) {
        unsubscribe();
        clearTimeout(fallback);
        resolve();
      }
    });
    const fallback = setTimeout(() => {
      unsubscribe();
      resolve();
    }, timeoutMs);
    for (const record of alive) {
      // 已退出竞态（kill 返回拒绝）与端口异常都不阻塞其余会话
      try {
        sessions.kill(record.sessionId);
      } catch {
        // 继续 wait exit / 兜底超时
      }
    }
  });
}

/**
 * 重启收尾（应用启动装配区调用，spec「重启后不恢复」）：清空终端注册表。
 * 注册表是内存态，新进程启动时本应为空——此函数是防御性收尾（万一有存活
 * 会话先按已退出收尾再清理，正常启动两步都 no-op）+ 08 票落库后的衔接挂点
 * （库中残留 running 行按已退出置终态的收尾挂在 main.ts 启动收尾区，与本
 * 函数同一时点；挂点注释见 main.ts）。taskIds 为现存任务 id 清单（启动时
 * manager.list() 尚未恢复执行，直接传入即可）。
 */
export async function settleTerminalSessionsOnStartup(
  sessions: TerminalSessionManager,
  taskIds: readonly string[]
): Promise<void> {
  // 存活会话按已退出收尾（kill + exit 置终态；端口异常时 killAll 内部兜底
  // 超时强制置终态）。正常重启时注册表为空，立即返回。
  await sessions.killAll();
  // 清空注册表：已退出会话全部 discard——UI 的 list-for 初始拉取从此无
  // 幽灵会话（04 票事件驱动下 UI 无需额外通知）。
  for (const taskId of taskIds) {
    for (const record of sessions.sessionsFor(taskId)) {
      sessions.discard(record.sessionId);
    }
  }
}
