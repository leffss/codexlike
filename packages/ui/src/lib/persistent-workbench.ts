import {
  workbenchKey,
  type WorkbenchEntry,
  type WorkbenchTarget,
  type WorkbenchValue,
} from "@codexlike/agent-core";
import type { CodexLikeApi } from "@codexlike/desktop/ipc";

export type WorkbenchPort = CodexLikeApi["workbench"];

/** 按目标串行写入，响应只确认 revision，不能回灌覆盖用户的新输入。 */
export function createPersistentWorkbench(
  port: WorkbenchPort | undefined,
  changed: () => void
) {
  const entries = new Map<string, WorkbenchEntry>();
  const loads = new Map<string, Promise<WorkbenchEntry | undefined>>();
  const writes = new Map<string, Promise<void>>();
  const errors = new Map<string, string>();
  const removed = new Set<string>();
  function load(target: WorkbenchTarget): Promise<WorkbenchEntry | undefined> {
    const key = workbenchKey(target);
    if (removed.has(key)) return Promise.resolve(undefined);
    if (entries.has(key)) return Promise.resolve(entries.get(key));
    if (!port) return Promise.resolve(undefined);
    let task = loads.get(key);
    if (!task) {
      task = port
        .read(target)
        .then((entry) => {
          if (removed.has(key)) return undefined;
          entries.set(key, entry);
          return entry;
        })
        .catch((error: unknown) => {
          if (removed.has(key)) return undefined;
          throw error;
        })
        .finally(() => loads.delete(key));
      loads.set(key, task);
    }
    return task;
  }
  function patch(
    target: WorkbenchTarget,
    update: (value: WorkbenchValue) => WorkbenchValue
  ) {
    if (!port) return;
    const key = workbenchKey(target);
    if (removed.has(key)) return;
    const task = (writes.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const current = await load(target);
        if (!current || removed.has(key)) return;
        const entry = {
          revision: current.revision + 1,
          value: update(current.value),
        };
        // 失败也保留本地待写快照；后续字段编辑必须在它之上合并。
        entries.set(key, entry);
        const result = await port.write(target, entry);
        if (removed.has(key)) return;
        entries.set(key, result.entry);
        if (!result.accepted)
          throw new Error("持久工作现场已更新，请重新打开该入口后再编辑");
        errors.delete(key);
        changed();
      })
      .catch((error: unknown) => {
        if (removed.has(key)) return;
        errors.set(key, error instanceof Error ? error.message : String(error));
        changed();
      });
    writes.set(key, task);
    void task.finally(() => {
      if (writes.get(key) === task) writes.delete(key);
    });
  }
  return {
    load,
    patch,
    /** 记录已由宿主移除：丢弃排队写入及迟到响应，不能污染其他会话的flush。 */
    remove(target: WorkbenchTarget) {
      const key = workbenchKey(target);
      removed.add(key);
      entries.delete(key);
      errors.delete(key);
      loads.delete(key);
      writes.delete(key);
    },
    forget(target: WorkbenchTarget) {
      entries.delete(workbenchKey(target));
    },
    error: () => [...errors.values()][0] ?? null,
    /** 08 退出流程可 await 此屏障；失败抛出，不谎报已保存。 */
    async flush() {
      while (writes.size) await Promise.all([...writes.values()]);
      if (errors.size) throw new Error([...errors.values()].join("；"));
    },
  };
}
