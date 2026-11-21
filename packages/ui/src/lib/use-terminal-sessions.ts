import { useCallback, useEffect, useRef, useState } from "react";

import type { TerminalSessionRecord } from "@codexlike/agent-core";

import {
  mergeTerminalRecords,
  terminalSegmentsFromRecords,
  upsertTerminalSession,
  type TerminalSegment,
} from "./task-view";

/**
 * 终端会话列表数据源 hook（ADR 0033 票 04，RailPanel 内装配，先例
 * useGitStatus）：列表数据源 = `terminals:list-for` 初始 + 恢复快照记录
 * （票 08，view 并行字段经 props 注入）合并 + `terminal-*` 事件增量归并，
 * 切任务时重建（对齐消息段流/工作台目标的单任务内存口径）。
 *
 * - 初始拉取：taskId 挂载/切换即重置内存并 list-for，与恢复快照记录合并
 *   （重启后注册表为空、list-for 空清单，恢复记录即「已退出」组数据源；
 *   同进程两源同会话去重 live 优先，generation 守卫防旧任务迟到的响应
 *   覆盖新任务清单）；record 含快照字段进合并层数据源，进段投影丢弃
 *   （大文本不进 React 状态，回看走 subscribe buffered）；
 * - 事件增量：onTaskEvent 信封按 taskId 过滤，terminal-started/exited 的
 *   record 幂等 upsert（与消息段流同构归并，task-view 单一来源）；
 * - 创建/终止：create（超上限中文 reason 直接回传展示，不另造错误态）与
 *   kill（用户 kill 不弹确认；进程退出由 terminal-exited 事件推进呈现）。
 */
export function useTerminalSessions(
  taskId: string | null,
  restored: TerminalSessionRecord[] = []
) {
  const [sessions, setSessions] = useState<TerminalSegment[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [killingSessionId, setKillingSessionId] = useState<string | null>(null);
  /** list-for 响应的代次守卫（旧任务迟到响应不覆盖新任务清单） */
  const requestRef = useRef(0);

  /**
   * 恢复记录内容键（票 08）：引用作依赖会无限重跑——调用方常以内联字面量
   * 传参、缺省参数每次渲染也新建数组（rail-diff-refresh-ui 的 worker OOM
   * 教训）；内容不变不重复触发初始拉取。键取会话身份 + 状态机字段：同
   * sessionId 的行字段在 exit 时刻定格不变，键变即内容变。
   */
  const restoredKey = restored
    .map(
      (record) =>
        `${record.sessionId}:${record.status}:${record.exitedAt ?? ""}`
    )
    .join("|");

  // 切任务重建：重置内存 + 初始拉取（list-for 与恢复快照记录合并，含已
  // 退出记录，列表分组数据源）
  useEffect(() => {
    const generation = ++requestRef.current;
    setSessions([]);
    setCreateError(null);
    if (taskId === null) return;
    let active = true;
    window.codexlike.terminals
      .listFor(taskId)
      .then((records: TerminalSessionRecord[]) => {
        if (!active || requestRef.current !== generation) return;
        setSessions(
          terminalSegmentsFromRecords(mergeTerminalRecords(restored, records))
        );
      })
      .catch(() => {
        // 拉取失败按空清单呈现（创建入口仍可用，失败原因在创建时可见）
      });
    return () => {
      active = false;
    };
    // restored 经内容键进依赖（键变即内容变，引用每次渲染新建不作依赖）
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restoredKey 已表达 restored 的内容变化
  }, [taskId, restoredKey]);

  // terminal-* 事件增量归并（只吃本任务信封；record 为事件时刻完整副本）
  useEffect(() => {
    if (taskId === null) return;
    return window.codexlike.onTaskEvent((envelope) => {
      if (envelope.taskId !== taskId) return;
      const event = envelope.event;
      if (
        event.type === "terminal-started" ||
        event.type === "terminal-exited"
      ) {
        setSessions((previous) =>
          upsertTerminalSession(previous, event.record)
        );
      }
    });
  }, [taskId]);

  const createSession = useCallback(() => {
    if (taskId === null) return;
    setCreating(true);
    setCreateError(null);
    window.codexlike.terminals
      .create({ taskId })
      .then((result) => {
        if (!result.ok) setCreateError(result.reason);
        // ok 会话清单由 terminal-started 事件归并（事件即呈现，不重复拉取）
      })
      .catch((error: unknown) => {
        setCreateError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setCreating(false);
      });
  }, [taskId]);

  const killSession = useCallback((sessionId: string) => {
    setKillingSessionId(sessionId);
    void window.codexlike.terminals
      .kill(sessionId)
      // 失败静默：明确的拒绝场景（重复 kill 已退出会话）在事件推进后按钮
      // 已消失，是正常竞态，无需错误态（ADR 0033 kill 非破坏性不弹确认）
      .catch(() => {})
      .finally(() => {
        setKillingSessionId((current) =>
          current === sessionId ? null : current
        );
      });
  }, []);

  return {
    sessions,
    createError,
    creating,
    createSession,
    killingSessionId,
    killSession,
  };
}
