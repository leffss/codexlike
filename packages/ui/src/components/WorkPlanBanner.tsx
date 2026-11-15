/**
 * 工作计划悬浮徽章（GLOSSARY「工作计划」，ADR 0016，原型 C 定稿，快照见
 * prototype/plan-banner 分支）：fixed 悬浮一颗 44px 进度环徽章——默认位置
 * 页面垂直中央、消息区左缘（流内零高锚测量，ResizeObserver 跟随侧栏开合），
 * 轻点展开完整步骤面板，按住拖动自定义位置（>4px 阈值区分轻点），右键弹
 * 「回到默认位置」。位置记忆走 collapse-memory 任务作用域（ADR 0011 渲染层
 * 内存态：跨任务/重挂载不丢；重启回默认锚定位——记忆的是视口坐标，重启后
 * 窗口尺寸可能不同）。弹层贴边避让：实测尺寸翻转（水平左/右对齐、垂直
 * 上/下弹出），一侧仍放不下时动态压 maxHeight 内部滚动兜底。
 * 当前计划由段序列派生（lib/plan-view），流内调用处只留一行标记
 * （PlanMarkerRow），不渲染通用工具卡。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  clearRememberedPosition,
  rememberedPosition,
  setRememberedPosition,
  useCollapseState,
} from "../lib/collapse-memory";
import {
  activeStep,
  collectPlanSnapshots,
  completedCount,
  type PlanSnapshot,
  type PlanStep,
  type PlanStepStatus,
} from "../lib/plan-view";

/** 徽章固定尺寸（size-11 = 44px），拖动边界 clamp 与避让计算用 */
const BADGE_SIZE = 44;
/** 弹层与徽章的间距（mt-2/mb-2 = 8px） */
const POP_GAP = 8;
/** 视口边缘留缝（clamp 与避让计算用） */
const EDGE_GAP = 8;
/** 拖动位移超过该阈值才算拖动，否则视为轻点（展开/收起） */
const DRAG_THRESHOLD = 4;
/** 面板步骤列表高度上限（max-h-72），避让兜底的上界 */
const PANEL_MAX_H = 288;
/** 右键菜单固定尺寸（w-40，单项高约 36px），贴边避让计算用 */
const MENU_WIDTH = 160;
const MENU_HEIGHT = 36;

/**
 * 视口尺寸：渲染期避让与 clamp 计算。SSR（静态渲染单测）无 window，
 * 兜底值只保证可执行——位置数值不参与任何断言。
 */
function viewportSize(): { w: number; h: number } {
  if (typeof window === "undefined") return { w: 1280, h: 720 };
  return { w: window.innerWidth, h: window.innerHeight };
}

/**
 * 三态图标（ZCode 同构语义）：pending 空心圆最弱；in_progress 用**静态箭头**
 * ——计划徽章会长时间停留在页面上，spinner 暗示「加载中」而非「当前所在
 * 步骤」，语义错位；completed 实心对勾成功色。
 */
export function StepStatusIcon(props: { status: PlanStepStatus }) {
  const { status } = props;
  if (status === "completed") {
    return (
      <svg
        viewBox="0 0 16 16"
        className="size-3.5 shrink-0 text-ok-fg"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6.2" />
        <path
          d="m5.4 8.2 1.8 1.8 3.4-3.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <svg
        viewBox="0 0 16 16"
        className="size-3.5 shrink-0 text-fg"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3.5 8h8m-3-3 3 3-3 3" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0 text-fg-subtle"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.2" />
    </svg>
  );
}

const stepTextClasses: Record<PlanStepStatus, string> = {
  pending: "text-fg-subtle",
  in_progress: "text-fg",
  completed: "text-fg-subtle line-through",
};

/** 步骤行：三态图标 + 内容（完成项删除线），展开面板用 */
function StepRow(props: { step: PlanStep }) {
  const { step } = props;
  return (
    <div className="flex min-w-0 items-start gap-2 py-0.5">
      <span className="mt-0.5">
        <StepStatusIcon status={step.status} />
      </span>
      <span
        className={`min-w-0 break-words text-xs leading-5 ${stepTextClasses[step.status]}`}
      >
        {step.content}
      </span>
    </div>
  );
}

/** 工作计划类别图标（流内标记行用） */
function PlanIcon(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={props.className ?? "size-3.5 shrink-0 text-fg-muted"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 4h1.8M7 4h6.5M2.5 8h1.8M7 8h6.5M2.5 12h1.8M7 12h6.5" />
      <path d="m3.4 3.4 1 1 1.6-2" className="opacity-70" />
    </svg>
  );
}

/**
 * 流内极简标记行（ADR 0016）：update_plan 调用在消息流原位只留一行
 * 小字回看「当时更新到哪」，不占过程区空间（当前状态看悬浮徽章）。
 */
export function PlanMarkerRow(props: {
  snapshot: PlanSnapshot;
  index: number;
}) {
  const { snapshot, index } = props;
  const done = completedCount(snapshot.steps);
  const active = activeStep(snapshot.steps);
  return (
    <li
      data-testid="plan-marker-row"
      className="flex min-w-0 items-center gap-2 py-0.5 text-xs text-fg-subtle"
    >
      <span className="shrink-0 opacity-70">
        <PlanIcon className="size-3 shrink-0" />
      </span>
      <span className="shrink-0">计划更新 {index + 1}</span>
      <span className="shrink-0 font-mono">
        {done}/{snapshot.steps.length}
      </span>
      {active && (
        <span className="min-w-0 flex-1 truncate opacity-80">
          {active.content}
        </span>
      )}
    </li>
  );
}

/** 视口内 clamp（EDGE_GAP 留缝；徽章尺寸固定，无需实测） */
function clampBadge(
  x: number,
  y: number,
  viewport: { w: number; h: number }
): { x: number; y: number } {
  return {
    x: Math.min(Math.max(x, EDGE_GAP), viewport.w - BADGE_SIZE - EDGE_GAP),
    y: Math.min(Math.max(y, EDGE_GAP), viewport.h - BADGE_SIZE - EDGE_GAP),
  };
}

/**
 * 工作计划悬浮徽章：内容 = 当前计划（最后一次 update_plan，全量替换
 * 语义）。props.className 不再消费（徽章 fixed 悬浮，与内容列宽解耦）。
 */
export function WorkPlanBanner(props: {
  items: PlanSnapshot[];
  taskId?: string | null;
}) {
  const { items, taskId } = props;
  // 位置记忆任务作用域（徽章单例元素，跨任务串位置会跳位）
  const posKey = `plan-badge-pos-${taskId ?? "none"}`;
  const { open, toggle } = useCollapseState(
    `plan-banner-${taskId ?? "none"}`,
    false
  );
  const latest = items.at(-1);
  const steps = useMemo(() => latest?.steps ?? [], [latest]);

  const anchorRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLDivElement>(null);
  // 徽章左上角视口坐标：undefined = 未自定义（默认锚定位）
  const [pos, setPos] = useState(() => rememberedPosition(posKey));
  // 右键菜单位置（视口坐标），null = 关闭
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // null = 尚未测得消息区左缘（首帧不渲染徽章，测完后出现）
  const [anchorX, setAnchorX] = useState<number | null>(null);
  const drag = useRef<{
    pointerX: number;
    pointerY: number;
    baseX: number;
    baseY: number;
    moved: boolean;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 面板实测尺寸（避让翻转的依据）。setPanelSize 做值比较（同尺寸返回
  // 原引用 bail out）——deps 若用 items 引用（流式更新每渲染都变）会
  // 测量→setState→重渲染→再测量无限循环
  const [panelSize, setPanelSize] = useState<{ w: number; h: number } | null>(
    null
  );

  // 水平锚测量：fixed 后拿不到消息区左缘（还随侧栏开合变化），留一个
  // 流内零高占位元素测量 rect.left。「有计划」翻转时锚元素才真正渲染，
  // effect 须随之重跑再测量
  const hasPlan = steps.length > 0;
  useEffect(() => {
    if (!hasPlan) return;
    function measure() {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) setAnchorX(rect.left);
    }
    measure();
    const el = anchorRef.current;
    if (el === null) return;
    // 侧栏开合改变消息区宽度 → 占位元素尺寸变化 → 重测左缘
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [hasPlan]);

  // 右键菜单开着时，页面任意按下即关闭（菜单项自己的 pointerdown 先于
  // window 的 bubble 监听跑，动作不受影响）
  useEffect(() => {
    if (menu === null) return;
    function close() {
      setMenu(null);
    }
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  // 面板尺寸测量：open 翻转或步骤数变化时重测；useLayoutEffect 在 paint
  // 前完成二次渲染，首帧避让不闪
  useLayoutEffect(() => {
    if (!open) {
      setPanelSize(null);
      return;
    }
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPanelSize((prev) =>
      prev?.w === rect.width && prev?.h === rect.height
        ? prev
        : { w: rect.width, h: rect.height }
    );
  }, [open, steps.length]);

  if (steps.length === 0) return null;

  const done = completedCount(steps);
  const active = activeStep(steps);
  const allDone = done === steps.length;

  function onPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    const rect = badgeRef.current?.getBoundingClientRect();
    drag.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      baseX: pos?.x ?? rect?.left ?? 0,
      baseY: pos?.y ?? rect?.top ?? 0,
      moved: false,
    };
    // capture 后 move/up 都派发给按钮，拖出徽章范围也不丢
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.pointerX;
    const dy = event.clientY - state.pointerY;
    if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    state.moved = true;
    setPos(clampBadge(state.baseX + dx, state.baseY + dy, viewportSize()));
  }

  function onPointerUp() {
    const state = drag.current;
    drag.current = null;
    if (state && !state.moved) {
      // 无位移 = 轻点：展开/收起（不用 onClick，避免拖动松手误触发）
      toggle();
      return;
    }
    // 拖动收官：以实测左上角为准，clamp 后写记忆（跨任务/重挂载不丢）
    const rect = badgeRef.current?.getBoundingClientRect();
    if (rect) {
      const final = clampBadge(rect.left, rect.top, viewportSize());
      setPos(final);
      setRememberedPosition(posKey, final);
    }
  }

  function onContextMenu(event: React.MouseEvent) {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  }

  function resetPosition() {
    setPos(undefined);
    clearRememberedPosition(posKey);
    setMenu(null);
  }

  // 渲染位置：自定义位置（含窗口缩放后出界的记忆值）渲染时 clamp；
  // 默认锚定位 top-50vh 是中心点，需 -translate-y-1/2 上移半高
  const viewport = viewportSize();
  const view = pos ? clampBadge(pos.x, pos.y, viewport) : undefined;
  const posStyle = view
    ? { left: view.x, top: view.y }
    : { left: anchorX ?? 0, top: "50vh" };
  // 徽章当前视口左上角（避让计算的基准；默认锚定位折算 translate 后位置）
  const badgeX = view?.x ?? anchorX ?? 0;
  const badgeY = view?.y ?? viewport.h / 2 - BADGE_SIZE / 2;
  // 弹层避让：右侧放不下 → 右缘对齐徽章右缘向左弹；下方放不下且上方
  // 更宽裕 → 向上弹；选中一侧仍放不下（超长计划）→ 动态压 maxHeight
  // 用内部滚动兜底，任何位置都不出视口
  const flipLeft = badgeX + (panelSize?.w ?? 0) + EDGE_GAP > viewport.w;
  const spaceDown = viewport.h - badgeY - BADGE_SIZE - POP_GAP - EDGE_GAP;
  const spaceUp = badgeY - POP_GAP - EDGE_GAP;
  const flipUp =
    panelSize !== null && panelSize.h > spaceDown && spaceUp > spaceDown;
  const panelMaxH = Math.min(PANEL_MAX_H, flipUp ? spaceUp : spaceDown);
  // 进度环几何：r=18，周长≈113；stroke-dasharray 按完成占比填充
  const R = 18;
  const CIRC = 2 * Math.PI * R;
  const filled = steps.length === 0 ? 0 : (done / steps.length) * CIRC;

  return (
    <>
      {/* 流内零高锚：仅用于测量消息区内容左缘（不渲染任何视觉） */}
      <div ref={anchorRef} className="h-0 w-full" aria-hidden="true" />
      <div
        ref={badgeRef}
        data-testid="plan-banner"
        className={`pointer-events-none fixed z-10 ${view ? "" : "-translate-y-1/2"}`}
        style={posStyle}
      >
        <div className="pointer-events-auto relative">
          <button
            type="button"
            data-testid="plan-banner-toggle"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onContextMenu={onContextMenu}
            aria-expanded={open}
            aria-label={`工作计划 ${done}/${steps.length}${allDone ? "，全部完成" : ""}${active && !allDone ? `，当前：${active.content}` : ""}——轻点展开，按住拖动，右键复位`}
            className="relative grid size-11 cursor-grab touch-none place-items-center rounded-full border border-line bg-surface shadow-lg active:cursor-grabbing"
          >
            <svg
              data-testid="plan-badge-ring"
              viewBox="0 0 44 44"
              className="size-10 -rotate-90"
              role="progressbar"
              aria-valuenow={done}
              aria-valuemin={0}
              aria-valuemax={steps.length}
            >
              <circle
                cx="22"
                cy="22"
                r={R}
                fill="none"
                className="stroke-surface-muted"
                strokeWidth="3.5"
              />
              <circle
                cx="22"
                cy="22"
                r={R}
                fill="none"
                className="stroke-accent"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeDasharray={`${filled} ${CIRC - filled}`}
              />
            </svg>
            <span
              data-testid="plan-banner-count"
              className="absolute font-mono text-[10px] text-fg"
            >
              {done}/{steps.length}
            </span>
          </button>
          {open && (
            <div
              ref={panelRef}
              data-testid="plan-banner-panel"
              className={`absolute z-10 w-80 max-w-[calc(100vw-32px)] rounded-xl border border-line bg-surface p-3 shadow-xl ${
                flipLeft ? "right-0" : "left-0"
              } ${flipUp ? "bottom-full mb-2" : "top-full mt-2"}`}
            >
              <div className="mb-1.5 flex items-center gap-2 border-b border-line pb-1.5">
                <PlanIcon className="size-3.5 shrink-0 text-accent" />
                <span className="text-xs font-medium text-fg">工作计划</span>
                <span className="ml-auto shrink-0 font-mono text-xs text-fg-subtle">
                  {done}/{steps.length}
                </span>
              </div>
              <div className="overflow-y-auto" style={{ maxHeight: panelMaxH }}>
                {steps.map((step) => (
                  <StepRow key={step.id} step={step} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {menu && (
        <div
          data-testid="plan-badge-menu"
          className="fixed z-50 w-40 rounded-md border border-line bg-surface p-1 shadow-lg"
          // 贴边避让：右缘/下缘出界时向左/上翻
          style={{
            left:
              menu.x + MENU_WIDTH > viewport.w - EDGE_GAP
                ? menu.x - MENU_WIDTH
                : menu.x,
            top:
              menu.y + MENU_HEIGHT > viewport.h - EDGE_GAP
                ? menu.y - MENU_HEIGHT
                : menu.y,
          }}
        >
          <button
            type="button"
            // pointerdown 而非 click：window 层的 pointerdown 监听先关
            // 菜单，click 到不了已卸载的菜单项
            onPointerDown={resetPosition}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-fg-muted hover:bg-hover hover:text-fg"
          >
            回到默认位置
          </button>
        </div>
      )}
    </>
  );
}

/** 便捷入口：由消息段序列收集快照后渲染徽章（无计划时渲染 null） */
export function WorkPlanBannerFromSegments(props: {
  items: import("../lib/task-view").MessageSegment[];
  taskId?: string | null;
}) {
  const snapshots = useMemo(
    () => collectPlanSnapshots(props.items),
    [props.items]
  );
  if (snapshots.length === 0) return null;
  return <WorkPlanBanner items={snapshots} taskId={props.taskId} />;
}
