import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { ExitState } from "@codexlike/desktop/ipc";
import type { WorkspaceState } from "../lib/workspace-state";

/** 独立于工作台/搜索/设置页；冻结编辑后复用票03唯一保存屏障。 */
export function ApplicationExit(props: {
  state: WorkspaceState;
  children: ReactNode;
}) {
  const [exit, setExit] = useState<ExitState>({ id: "", phase: "idle" });
  const flushing = useRef(new Set<string>());
  useEffect(() => {
    const api = window.codexlike.application;
    let alive = true;
    let observed = false;
    function receive(state: ExitState) {
      if (!alive) return;
      flushSync(() => setExit(state));
      if (state.phase !== "flushing" || flushing.current.has(state.id)) return;
      flushing.current.add(state.id);
      void props.state.flush().then(
        () => api.flushed(state.id),
        (error: unknown) =>
          api.flushed(
            state.id,
            error instanceof Error ? error.message : String(error)
          )
      );
    }
    const unsubscribe = api.onExitState((state) => {
      observed = true;
      receive(state);
    });
    void api.exitState().then((state) => {
      if (!observed) receive(state);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [props.state]);
  const blocked = !["idle", "error"].includes(exit.phase);
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col" inert={blocked}>
        {props.children}
      </div>
      {blocked && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="退出应用"
            className="max-w-md rounded-lg border border-line bg-surface p-6 text-fg shadow-xl"
          >
            {exit.phase === "confirming" ? (
              <>
                <h2 className="mb-3 font-semibold">仍有未完成执行或等待回应</h2>
                <p className="mb-5 text-sm">
                  退出将中断所有任务及子代理。已保存的历史和草稿会保留，重启不会自动继续执行。
                </p>
                <div className="flex justify-end gap-3">
                  <button
                    data-testid="exit-cancel"
                    autoFocus
                    className="rounded border border-line px-3 py-2"
                    onClick={() =>
                      void window.codexlike.application.answerExit(
                        exit.id,
                        false
                      )
                    }
                  >
                    取消退出
                  </button>
                  <button
                    data-testid="exit-confirm"
                    className="rounded bg-accent px-3 py-2 text-on-accent"
                    onClick={() =>
                      void window.codexlike.application.answerExit(
                        exit.id,
                        true
                      )
                    }
                  >
                    中断并退出
                  </button>
                </div>
              </>
            ) : (
              <p data-testid="exit-progress">
                {exit.phase === "flushing"
                  ? "正在保存工作现场…"
                  : "正在停止执行并退出…"}
              </p>
            )}
          </section>
        </div>
      )}
      {exit.phase === "error" && (
        <div
          role="alert"
          data-testid="exit-error"
          className="fixed bottom-4 left-4 z-50 rounded border border-line bg-surface p-4 text-fg"
        >
          {exit.error}
        </div>
      )}
    </>
  );
}
