import type {
  TerminalSessionEvent,
  TerminalSessionRecord,
} from "@codexlike/agent-core";
import type {
  TaskPersistence,
  TerminalSessionManager,
} from "@codexlike/agent-core/node";

/**
 * 终端会话生命周期硬边的宿主侧组合件（ADR 0033 票07）。manager（宿主级注册表）
 * 不按本票范围改动，这里只用其公开接口组合出三个生命周期动作：
 * 存活计数（确认提示口径）、closeTaskSessions（归档先杀后归档）、
 * settleTerminalSessionsOnStartup（重启收尾）。
 * 票 08 追加快照落库三件：recordTerminalSessionEvent（事件 → 表行的落库桥）、
 * persistExitedSessionSnapshots（退出屏障 flush）、
 * settleTerminalSessionRowsOnStartup（重启收尾库层衔接）。
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

/**
 * 终端会话退出推进的 update patch（code review 修复轮收敛：原先事件桥与
 * 退出屏障各写一份同款字段清单）：status/exitedAt/exitCode/signal/snapshot
 * 五列 + 标题两列（标题功能轮：终态 record 携带的最终标题随终态落库，重启
 * 恢复的只读回看行保留 OSC 动态值 / 用户改名），即
 * persistence.updateTerminalSession 契约注释声明的可更新全集。
 * exitCode/signal/快照缺省容忍（兜底置终态的 record 无 exitCode）。
 */
function terminalExitPatch(record: TerminalSessionRecord): {
  status: TerminalSessionRecord["status"];
  exitedAt?: string;
  exitCode?: number;
  signal?: number;
  snapshot?: string;
  title?: string;
  titleSource?: TerminalSessionRecord["titleSource"];
} {
  return {
    status: record.status,
    exitedAt: record.exitedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    snapshot: record.snapshot,
    ...(record.title !== undefined ? { title: record.title } : {}),
    ...(record.titleSource !== undefined
      ? { titleSource: record.titleSource }
      : {}),
  };
}

/**
 * 终端会话落库桥（ADR 0033 票 08）：manager.onEvent → `terminal_sessions`
 * 表行。spawn 即写骨架行（status=running）——进程中途被杀也有「曾开过」
 * 的留痕（先例 subagents 注册行 queued 即写，ADR 0021）；exit 事件定格
 * 快照后一次推进终态（killAll 等 exit 齐全语义保证快照已定格再写）；
 * 标题变化（标题功能轮）即时落标题两列——行随内存 record 同步，应用中途
 * 被杀时库行不丢改名。exitCode/signal/快照缺省容忍（兜底置终态的 record
 * 无 exitCode）。目标行不存在时静默忽略（updateSubagent 同语义）。
 */
export function recordTerminalSessionEvent(
  persistence: TaskPersistence,
  event: TerminalSessionEvent
): void {
  if (event.kind === "terminal-started") {
    persistence.insertTerminalSession(event.record);
    return;
  }
  if (event.kind === "terminal-title-changed") {
    const { record } = event;
    persistence.updateTerminalSession(record.sessionId, {
      ...(record.title !== undefined ? { title: record.title } : {}),
      ...(record.titleSource !== undefined
        ? { titleSource: record.titleSource }
        : {}),
    });
    return;
  }
  const { record } = event;
  persistence.updateTerminalSession(
    record.sessionId,
    terminalExitPatch(record)
  );
}

/**
 * 退出屏障 flush 快照落库（ADR 0033 票 08，releaseResources 挂点）：killAll
 * 返回即 exit 齐全（各会话快照已定格），逐条把现存任务的 exited 记录推进
 * 落库——事件桥漏写的行由此兜底，已写过的行同值重写幂等。孤儿会话（归属
 * 任务已移除，不在 taskIds）不推进：其行已随任务数据删除。须在 app.quit
 * （closeStorage 关库）之前完成。
 */
export function persistExitedSessionSnapshots(
  persistence: TaskPersistence,
  sessions: TerminalSessionManager,
  taskIds: readonly string[]
): void {
  for (const taskId of taskIds) {
    for (const record of sessions.sessionsFor(taskId)) {
      if (record.status !== "exited") continue;
      persistence.updateTerminalSession(
        record.sessionId,
        terminalExitPatch(record)
      );
    }
  }
}

/**
 * 重启收尾库层衔接（ADR 0033 票 08，main.ts 启动收尾区挂点）：库中残留
 * running 行按已退出置终态——exitedAt 用收尾时刻，exitCode/signal/快照
 * 缺省（07 票锚口径 + 01 票兜底置终态 record 无 exitCode 的容忍）。须在
 * UI 从库读「已退出」列表（view 并行字段的恢复数据源）之前完成。崩溃
 * 进程的骨架行由此获得「曾开过 + 已终止」的留痕；正常重启时表中无
 * running 行，no-op。
 */
export function settleTerminalSessionRowsOnStartup(
  persistence: TaskPersistence,
  settledAt: string
): void {
  persistence.settleRunningTerminalSessions(settledAt);
}
