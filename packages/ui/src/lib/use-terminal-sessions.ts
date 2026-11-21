import { useCallback, useEffect, useRef, useState } from "react";

import type { TerminalSessionRecord } from "@codexlike/agent-core";

import {
  terminalSegmentsFromRecords,
  upsertTerminalSession,
  type TerminalSegment,
} from "./task-view";

/**
 * 终端会话列表数据源 hook（ADR 0033 票 04，RailPanel 内装配，先例
 * useGitStatus）：列表数据源 = `terminals:list-for` 初始 + `terminal-*`
 * 事件增量归并，切任务时重建（对齐消息段流/工作台目标的单任务内存口径）。
 *
 * - 初始拉取：taskId 挂载/切换即重置内存并 list-for（generation 守卫防
 *   旧任务迟到的响应覆盖新任务清单）；
 * - 事件增量：onTaskEvent 信封按 taskId 过滤，terminal-started/exited 的
 *   record 幂等 upsert（与消息段流同构归并，task-view 单一来源）；
 * - 创建/终止：create（超上限中文 reason 直接回传展示，不另造错误态）与
 *   kill（用户 kill 不弹确认；进程退出由 terminal-exited 事件推进呈现）。
 */
export function useTerminalSessions(taskId: string | null) {
  const [sessions, setSessions] = useState<TerminalSegment[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [killingSessionId, setKillingSessionId] = useState<string | null>(null);
  /** list-for 响应的代次守卫（旧任务迟到响应不覆盖新任务清单） */
  const requestRef = useRef(0);

  // 切任务重建：重置内存 + 初始拉取（含已退出记录，列表分组数据源）
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
        setSessions(terminalSegmentsFromRecords(records));
      })
      .catch(() => {
        // 拉取失败按空清单呈现（创建入口仍可用，失败原因在创建时可见）
      });
    return () => {
      active = false;
    };
  }, [taskId]);

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
