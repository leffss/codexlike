import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type {
  GitChangeKind,
  GitFileChange,
  GitFileDiff,
  GitStatus,
  TaskResourcesView,
} from "@codexlike/agent-core";

import { languageForPath } from "../lib/diff-language";
import { GitActions } from "./GitActions";
import {
  SnapshotSummary,
  SnapshotSwitcher,
  type SnapshotKey,
} from "./ResourceSnapshotSummary";

const MonacoDiff = lazy(() => import("./MonacoDiff"));

/**
 * 检视右栏（ADR 0018，prototype/panels-redesign 变体 A 折叠）：
 * 「改动」「规范与技能」两面板的常驻分栏容器，取代原 overlay 抽屉——
 * 打开时把消息流推窄（并列而非覆盖），中缝可拖拽调宽。
 *
 * 结构（自上而下）：
 * - tab 行：两个独立描边按钮（对标标题栏开关样式），单屏互斥切换；
 * - 改动 tab：当前分支行（行尾「刷新」）→ 变更文件清单 → 选中文件
 *   diff（Monaco 懒加载）→ 提交动作组（GitActions）；
 * - 规范与技能 tab：三档快照 chips（本轮/上轮/下轮预览）+ 密排摘要。
 *
 * 开合由标题栏「右栏开关」驱动（props.open，默认关闭）；关闭时本组件
 * 不渲染任何节点，但组件保持挂载——git 状态 hook 照常轮换，标题栏
 * 角标（未提交变更数，经 onChangesCount 上报）在关闭期间仍随
 * changesRevision 递增刷新。收起再展开恢复宽度与选中文件。
 */

/** 拖拽分栏约束（px）：右栏最小宽、正文最小宽、默认宽（25rem） */
const RAIL_MIN_WIDTH = 320;
const STREAM_MIN_WIDTH = 480;
const RAIL_DEFAULT_WIDTH = 400;

/**
 * 宽度夹取（拖拽与方向键共用）：右栏最小宽 RAIL_MIN_WIDTH、上限 max
 * （= 分栏容器宽 − 正文最小宽 STREAM_MIN_WIDTH）；导出供单测。
 */
export function clampRailWidth(width: number, max: number): number {
  return Math.min(max, Math.max(RAIL_MIN_WIDTH, width));
}

const CHANGE_KIND_LABELS: Record<GitChangeKind, string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
};

const CHANGE_KIND_CLASSES: Record<GitChangeKind, string> = {
  added: "bg-ok-bg text-ok-fg border-ok-fg/40",
  modified: "bg-info-bg text-info-fg border-info-fg/40",
  deleted: "bg-danger-bg text-danger-fg border-danger-fg/40",
  renamed: "bg-worktree-bg text-worktree-fg border-worktree-fg/40",
};

const EMPTY_SNAPSHOT_TEXT: Record<SnapshotKey, string> = {
  active: "当前没有运行中的资源快照",
  last: "尚无最近一轮摘要",
  preview: "暂无预览",
};

export function RailPanel(props: {
  /** 右栏展开态（状态在 WorkspacePage，标题栏开关驱动）；关闭时不渲染节点 */
  open: boolean;
  /** 当前任务 ID；null（草稿/未选任务）改动 tab 显示提示、不拉 git 状态 */
  taskId: string | null;
  taskTitle: string | null;
  selectedProfileId: string;
  /** 递增信号：一轮回答结束、右栏关闭等时机触发 git 状态重读 */
  changesRevision: number;
  resources: TaskResourcesView | null;
  resourcesLoading: boolean;
  resourcesError: string | null;
  onRefreshResources: () => void;
  /** 未提交变更数上报（非 git / 无任务为 null）：标题栏开关角标消费 */
  onChangesCount: (count: number | null) => void;
}) {
  const taskId = props.taskId;
  const hasTask = taskId !== null;
  const [tab, setTab] = useState<"changes" | "resources">("changes");
  const [selected, setSelected] = useState<GitFileChange | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotKey>("preview");

  const { status, loading, error, refresh } = useGitStatus(
    taskId,
    props.changesRevision
  );

  // ===== 拖拽分栏：宽度内存态（会话内保持；不持久化） =====
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; width: number; max: number } | null>(
    null
  );

  /** 宽度上限 = 分栏行（父级：主列 + 本右栏）宽 − 正文最小宽。
   *  注意量的是父级行而非本组件根节点——后者只含分隔条+右栏自身，
   *  减正文最小宽会得负值（原型踩坑转正记录）。 */
  function rowMaxWidth(): number {
    const row = layoutRef.current?.parentElement;
    if (row === null || row === undefined) return RAIL_DEFAULT_WIDTH;
    return row.getBoundingClientRect().width - STREAM_MIN_WIDTH;
  }

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (layoutRef.current === null) return;
    // 阻止 pointerdown 默认行为（否则合成 mouse 事件会开启原生文本划选）
    event.preventDefault();
    // 正文最小宽在拖动起点测一次（拖动期间窗口尺寸变化不在考虑内）
    const max = rowMaxWidth();
    dragStart.current = { x: event.clientX, width: railWidth, max };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    // 拖动期间禁选中（防正文文字被划选）并统一光标
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }

  function onDragMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = dragStart.current;
    if (start === null) return;
    // 右栏在右侧：向左拖 = 变宽；双端夹取最小宽
    const next = start.width + (start.x - event.clientX);
    setRailWidth(clampRailWidth(next, start.max));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragStart.current === null) return;
    dragStart.current = null;
    setDragging(false);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function onSeparatorKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    // ← 拉宽右栏，→ 收窄（与拖动方向一致），步进 24px
    const delta = event.key === "ArrowLeft" ? 24 : -24;
    setRailWidth((width) => clampRailWidth(width + delta, rowMaxWidth()));
  }

  // 任务切换后清掉选中文件，避免展示上一个任务的 diff
  useEffect(() => {
    setSelected(null);
  }, [taskId]);

  // 打开瞬间把记忆宽度夹到当前容器上限（窄窗口下 400 默认宽会把正文
  // 压穿 480 最小宽；上限优先——右栏跟随容器收窄保布局不溢出）
  useEffect(() => {
    if (!props.open) return;
    if (layoutRef.current === null) return;
    setRailWidth((width) => clampRailWidth(width, rowMaxWidth()));
  }, [props.open]);

  // 未提交变更数上报（右栏关闭时 hooks 照常运行，标题栏角标恒可更新）
  const onChangesCount = props.onChangesCount;
  const changesCount = status?.isGitRepo === true ? status.files.length : null;
  useEffect(() => {
    onChangesCount(changesCount);
  }, [changesCount, onChangesCount]);

  const files = status?.isGitRepo === true ? status.files : [];
  const snapshotSummary =
    props.resources !== null ? props.resources[snapshot] : null;

  // 关闭态：不渲染任何节点（组件保持挂载，状态与角标上报继续）
  if (!props.open) return null;

  return (
    <div ref={layoutRef} className="flex min-h-0 min-w-0">
      {/* 拖拽分隔条：双端最小宽夹取；双击复位；←/→ 微调。
          与右栏同生共死（关闭即卸载）——分隔条占位会让正文列的居中基准
          比输入框/审批框（以消息区容器为基准）窄 6px，错位。 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整右栏宽度"
        data-testid="rail-separator"
        tabIndex={0}
        title="拖动调整右栏宽度（正文与右栏都有最小宽度限制）；双击复位"
        onPointerDown={startDrag}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setRailWidth(RAIL_DEFAULT_WIDTH)}
        onKeyDown={onSeparatorKeyDown}
        className={`w-1.5 shrink-0 cursor-col-resize select-none transition-colors ${
          dragging ? "bg-accent/60" : "bg-transparent hover:bg-accent/40"
        }`}
      />
      <aside
        aria-label="检视右栏"
        data-testid="rail-panel"
        style={{ width: railWidth }}
        className="flex shrink-0 flex-col border-l border-line bg-surface text-sm"
      >
        {/* tab 行：独立描边按钮（对标标题栏开关样式），选中态 accent */}
        <div
          role="tablist"
          aria-label="右栏面板切换"
          className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "changes"}
            data-testid="rail-tab-changes"
            onClick={() => setTab("changes")}
            className={`shrink-0 rounded border px-2 py-1.5 text-xs ${
              tab === "changes"
                ? "border-accent text-accent"
                : "border-transparent text-fg-muted hover:bg-hover hover:text-fg"
            }`}
          >
            改动
            {/* 具体修改数紧跟标题（不截断；标题栏开关角标才有 99+ 限制） */}
            <span
              className={`ml-1 rounded-full px-1.5 py-0.5 text-xs ${
                files.length > 0
                  ? tab === "changes"
                    ? "bg-accent/15 text-accent"
                    : "bg-accent/10 text-fg-muted"
                  : "bg-surface-muted text-fg-subtle"
              }`}
            >
              {files.length}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "resources"}
            data-testid="rail-tab-resources"
            onClick={() => setTab("resources")}
            className={`shrink-0 rounded border px-2 py-1.5 text-xs ${
              tab === "resources"
                ? "border-accent text-accent"
                : "border-transparent text-fg-muted hover:bg-hover hover:text-fg"
            }`}
          >
            规范与技能
          </button>
        </div>
        {tab === "changes" ? (
          <div
            data-testid="changes-panel"
            role="tabpanel"
            className="flex min-h-0 flex-1 flex-col"
          >
            {/* 当前分支行：修改文件列表上方；行尾「刷新」 */}
            {status?.isGitRepo === true && (
              <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-2 text-xs text-fg-muted">
                当前分支：
                <span
                  data-testid="changes-branch"
                  className="truncate rounded bg-code-bg px-1.5 py-0.5 font-mono text-accent"
                  title="当前分支"
                >
                  {status.branch ?? "（无提交历史）"}
                </span>
                <button
                  type="button"
                  onClick={refresh}
                  disabled={loading}
                  className="ml-auto shrink-0 text-xs text-fg-muted hover:text-fg disabled:opacity-50"
                  title="重新读取 git 状态"
                >
                  刷新
                </button>
              </div>
            )}
            {error !== null ? (
              <p className="px-3 pb-2 text-xs text-danger-fg">{error}</p>
            ) : !hasTask ? (
              <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-fg-muted">
                草稿态暂无任务改动，发送首条消息后可检视。
              </div>
            ) : !loading && status?.isGitRepo === false ? (
              <div
                data-testid="changes-not-git"
                className="m-3 rounded border border-line bg-surface-muted p-3 text-sm text-fg-muted"
              >
                非 git 工作区：当前任务绑定的目录不受 git
                管理，无法查看改动或提交。
              </div>
            ) : (
              <ul className="max-h-[45%] shrink-0 overflow-auto py-0.5">
                {loading && (
                  <li className="px-3 py-1.5 text-xs text-fg-subtle">
                    读取 git 状态中…
                  </li>
                )}
                {files.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      data-testid="changes-file-item"
                      onClick={() => setSelected(file)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                        selected?.path === file.path
                          ? "bg-hover"
                          : "hover:bg-hover"
                      }`}
                    >
                      <span
                        className={`shrink-0 rounded border px-1.5 py-0.5 text-xs ${CHANGE_KIND_CLASSES[file.kind]}`}
                      >
                        {CHANGE_KIND_LABELS[file.kind]}
                      </span>
                      <span
                        className={`min-w-0 flex-1 truncate font-mono text-xs ${
                          selected?.path === file.path
                            ? "text-fg"
                            : "text-fg-muted"
                        }`}
                        title={file.path}
                      >
                        {file.path}
                      </span>
                    </button>
                  </li>
                ))}
                {!loading && files.length === 0 && (
                  <li className="px-3 py-1.5 text-xs text-fg-subtle">
                    工作区没有未提交的变更
                  </li>
                )}
              </ul>
            )}
            {selected !== null && taskId !== null ? (
              <DiffView
                key={`${taskId}:${selected.path}`}
                taskId={taskId}
                file={selected}
                className="min-h-0 flex-1 border-t border-line"
              />
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-fg-subtle">
                点上方文件查看 diff
              </div>
            )}
            {taskId !== null && status?.isGitRepo === true && (
              <div className="shrink-0 border-t border-line">
                <GitActions
                  taskId={taskId}
                  taskTitle={props.taskTitle ?? ""}
                  selectedProfileId={props.selectedProfileId}
                  onCommitted={refresh}
                />
              </div>
            )}
          </div>
        ) : (
          <div
            data-testid="resources-panel"
            role="tabpanel"
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
          >
            <div className="flex items-center justify-between gap-2">
              <SnapshotSwitcher value={snapshot} onChange={setSnapshot} />
              <button
                type="button"
                onClick={props.onRefreshResources}
                disabled={props.resourcesLoading}
                className="shrink-0 text-xs text-fg disabled:opacity-50"
              >
                刷新
              </button>
            </div>
            {props.resourcesError !== null && (
              <p role="alert" className="text-xs text-danger-fg">
                {props.resourcesError}
              </p>
            )}
            {props.resourcesLoading && (
              <p role="status" className="text-xs text-fg-muted">
                正在刷新资源…
              </p>
            )}
            {props.resources === null ? (
              props.resourcesError === null &&
              !props.resourcesLoading && (
                <p className="text-xs text-fg-muted">暂无资源信息</p>
              )
            ) : snapshotSummary === null ? (
              <p className="text-xs text-fg-subtle">
                {EMPTY_SNAPSHOT_TEXT[snapshot]}
              </p>
            ) : (
              <SnapshotSummary summary={snapshotSummary} />
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

/** git 状态读取 hook（无任务恒 null；revision 递增触发重读） */
function useGitStatus(
  taskId: string | null,
  revision: number
): {
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(taskId !== null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (taskId === null) {
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    window.codexlike.git
      .status(taskId)
      .then((next) => setStatus(next))
      .catch((err: unknown) => {
        setStatus(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [taskId]);

  useEffect(() => {
    refresh();
  }, [refresh, revision]);

  return { status, loading, error, refresh };
}

/** 单文件 diff 视图（路径行 + Monaco DiffEditor 懒加载） */
function DiffView(props: {
  taskId: string;
  file: GitFileChange;
  className?: string;
}) {
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    window.codexlike.git
      .diff(props.taskId, props.file.path, props.file.oldPath)
      .then((next) => {
        if (active) setDiff(next);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.taskId, props.file.path, props.file.oldPath]);

  return (
    <div className={`flex min-h-0 flex-col ${props.className ?? ""}`}>
      <div className="flex shrink-0 items-center border-b border-line px-3 py-1.5">
        <span
          data-testid="changes-diff-path"
          className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted"
          title={props.file.path}
        >
          {props.file.path}
        </span>
      </div>
      {loading ? (
        <div className="p-3 text-sm text-fg-subtle">加载 diff 中…</div>
      ) : error !== null ? (
        <div className="p-3 text-sm text-danger-fg">{error}</div>
      ) : (
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <div className="p-3 text-sm text-fg-subtle">加载 diff 视图…</div>
            }
          >
            <MonacoDiff
              original={diff?.original ?? ""}
              modified={diff?.modified ?? ""}
              language={languageForPath(props.file.path)}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
