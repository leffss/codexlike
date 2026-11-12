import type { CodexLikeApi, WindowState } from "@codexlike/desktop/ipc";

/** 将主进程窗口状态同步给 UI，返回订阅清理函数。 */
export function subscribeWindowState(
  api: NonNullable<CodexLikeApi["windowControls"]>,
  receive: (state: WindowState) => void
): () => void {
  let alive = true;
  let observed = false;
  // 先订阅再查询：事件比未决的初始快照更新，不能被旧快照回滚。
  const unsubscribe = api.onStateChanged((state) => {
    observed = true;
    if (alive) receive(state);
  });
  void api.getState().then(
    (state) => {
      if (alive && !observed) receive(state);
    },
    () => {
      // 初始查询失败时保留现状，后续事件仍可校准。
    }
  );
  return () => {
    alive = false;
    unsubscribe();
  };
}
