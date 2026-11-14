import type { ReactNode } from "react";

/** 抽屉 tab（票03）：「规范与技能」「改动」两面板共用同一浮层容器 */
export type DrawerTab = "resources" | "changes";

/** 抽屉两个 tab 的固定顺序与文案（模块私有：仅 tab 头渲染使用） */
const DRAWER_TABS: readonly { key: DrawerTab; label: string }[] = [
  { key: "resources", label: "规范与技能" },
  { key: "changes", label: "改动" },
] as const;

/**
 * 抽屉 tab 头（票03）：两个 tab 切换按钮 + × 关闭；独立导出供装配层
 * 复用与「直接调用元素 props」式组件测试（先例：window-controls-ui）。
 */
export function DrawerTabHeader(props: {
  active: DrawerTab;
  onTabChange: (tab: DrawerTab) => void;
  onClose: () => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="面板切换"
      className="flex shrink-0 items-stretch border-b border-line"
    >
      {DRAWER_TABS.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={props.active === key}
          data-testid={`drawer-tab-${key}`}
          onClick={() => props.onTabChange(key)}
          className={`flex-1 px-3 py-2 text-xs ${
            props.active === key
              ? "border-b-2 border-accent font-medium text-fg"
              : "text-fg-muted hover:bg-hover hover:text-fg"
          }`}
        >
          {label}
        </button>
      ))}
      <button
        type="button"
        data-testid="drawer-close"
        aria-label="关闭面板"
        title="关闭面板"
        onClick={props.onClose}
        className="w-9 shrink-0 text-fg-muted hover:bg-hover hover:text-fg"
      >
        ×
      </button>
    </div>
  );
}

/**
 * 右栏 overlay 抽屉（票03，spec「右栏 overlay 抽屉」）：
 * 「规范与技能」「改动」收进同一浮层，浮于消息流上方（absolute，
 * 不挤压内容列宽度），宽度 30rem、上限 60%（原型变体 D 参数）。
 * 面板本体（AgentResourcesPanel / ChangesPanel）经 props 注入，
 * 只有当前 tab 挂载；容器以覆盖类收敛面板原固定宽高（w-96 / w-[30rem]）
 * 与左缘描边，面板内部滚动、刷新、独立关闭能力不变。
 */
export function PanelsDrawer(props: {
  tab: DrawerTab;
  onTabChange: (tab: DrawerTab) => void;
  onClose: () => void;
  resources: ReactNode;
  changes: ReactNode;
}) {
  return (
    <aside
      data-testid="panels-drawer"
      aria-label="面板抽屉"
      className="absolute inset-y-0 right-0 z-20 flex w-[30rem] max-w-[60%] flex-col border-l border-line bg-surface shadow-2xl"
    >
      <DrawerTabHeader
        active={props.tab}
        onTabChange={props.onTabChange}
        onClose={props.onClose}
      />
      <div className="flex min-h-0 flex-1 flex-col [&>aside]:h-auto [&>aside]:min-h-0 [&>aside]:min-w-0 [&>aside]:w-full [&>aside]:flex-1 [&>aside]:border-l-0">
        {props.tab === "resources" ? props.resources : props.changes}
      </div>
    </aside>
  );
}
