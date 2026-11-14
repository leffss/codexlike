import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import {
  TitlebarPanelToggles,
  TitlebarTaskContext,
  WorkspaceBadgePopover,
  type TitlebarContext,
  type TitlebarTask,
} from "../src/components/TitlebarTaskContext";

/** 与 TaskRecord 形状一致的任务上下文样例（项目任务 · 托管 Worktree） */
function task(overrides: Partial<TitlebarTask> = {}): TitlebarTask {
  return {
    taskId: "task-1",
    title: "重构主窗口布局",
    projectName: "ai-agent",
    workspaceMode: "worktree",
    workspacePath: "C:\\Users\\leffss\\.codexlike\\worktrees\\task-1",
    workspaceOriginPath: "C:\\Users\\leffss\\Desktop\\ai-agent",
    ...overrides,
  };
}

function context(overrides: Partial<TitlebarContext> = {}): TitlebarContext {
  return {
    task: task(),
    search: { recordsRevision: 0, onSelect: () => {} },
    panels: {
      resourcesOpen: false,
      changesOpen: false,
      disabled: false,
      onToggleResources: () => {},
      onToggleChanges: () => {},
    },
    ...overrides,
  };
}

it("打开任务时标题栏展示品牌、任务名与「项目 · Worktree/本地」徽章", () => {
  const html = renderToStaticMarkup(
    createElement(TitlebarTaskContext, { context: context() })
  );
  expect(html).toContain("CodexLike");
  expect(html).toContain("›");
  expect(html).toMatch(/data-testid="task-title"[^>]*>重构主窗口布局<\/span>/);
  // 徽章：项目名 · 模式标签；模式标签保留独立定位器
  expect(html).toMatch(/data-testid="workspace-badge"/);
  expect(html).toContain("ai-agent");
  expect(html).toMatch(/data-testid="workspace-mode"[^>]*>\s*Worktree\s*</);
  // 任务搜索整体迁入标题栏：关闭态即切换按钮
  expect(html).toMatch(/data-testid="task-search-toggle"/);
});

it("徽章 hover 提示与点击弹层提供完整工作区路径与来源目录", () => {
  const sample = task();
  const html = renderToStaticMarkup(
    createElement(TitlebarTaskContext, { context: context() })
  );
  // hover title：完整工作区路径 + 来源目录
  expect(html).toContain(
    `title="工作区：${sample.workspacePath}\n来源目录：${sample.workspaceOriginPath}"`
  );
  // 点击后的弹层内容（纯展示子组件）：路径与来源目录各自成行
  const popover = renderToStaticMarkup(
    createElement(WorkspaceBadgePopover, { task: sample })
  );
  expect(popover).toMatch(/data-testid="workspace-path"/);
  expect(popover).toContain(sample.workspacePath);
  expect(popover).toMatch(/data-testid="workspace-origin"/);
  expect(popover).toContain(sample.workspaceOriginPath);
});

it("独立任务徽章回退「独立任务」，本地模式显示「本地」，无来源目录行", () => {
  const sample = task({
    projectName: null,
    workspaceMode: "local",
    workspaceOriginPath: null,
  });
  const html = renderToStaticMarkup(
    createElement(TitlebarTaskContext, {
      context: context({ task: sample }),
    })
  );
  expect(html).toContain("独立任务");
  expect(html).toMatch(/data-testid="workspace-mode"[^>]*>\s*本地\s*</);
  const popover = renderToStaticMarkup(
    createElement(WorkspaceBadgePopover, { task: sample })
  );
  expect(popover).toMatch(/data-testid="workspace-path"/);
  expect(popover).not.toMatch(/data-testid="workspace-origin"/);
});

it("无任务（未选任务/草稿）时回退品牌展示，不渲染任务名与徽章", () => {
  const html = renderToStaticMarkup(
    createElement(TitlebarTaskContext, {
      context: context({ task: null }),
    })
  );
  expect(html).toContain("CodexLike");
  expect(html).toContain("本地 AI coding agent 工作台");
  expect(html).not.toMatch(/data-testid="task-title"/);
  expect(html).not.toMatch(/data-testid="workspace-badge"/);
  // 任务搜索仍可用（能力不减）
  expect(html).toMatch(/data-testid="task-search-toggle"/);
});

it("面板开关保留定位器并同步 aria 状态，无任务时禁用", () => {
  const html = renderToStaticMarkup(
    createElement(TitlebarPanelToggles, {
      panels: {
        resourcesOpen: true,
        changesOpen: true,
        disabled: false,
        onToggleResources: () => {},
        onToggleChanges: () => {},
      },
    })
  );
  expect(html).toMatch(
    /data-testid="resources-toggle"[^>]*aria-expanded="true"/
  );
  expect(html).toMatch(/data-testid="changes-toggle"[^>]*aria-expanded="true"/);
  expect(html).toContain("收起改动");
  const collapsed = renderToStaticMarkup(
    createElement(TitlebarPanelToggles, {
      panels: {
        resourcesOpen: false,
        changesOpen: false,
        disabled: false,
        onToggleResources: () => {},
        onToggleChanges: () => {},
      },
    })
  );
  expect(collapsed).toMatch(
    /data-testid="changes-toggle"[^>]*aria-expanded="false"/
  );
  expect(collapsed).toContain("改动");
  const disabled = renderToStaticMarkup(
    createElement(TitlebarPanelToggles, {
      panels: {
        resourcesOpen: false,
        changesOpen: false,
        disabled: true,
        onToggleResources: () => {},
        onToggleChanges: () => {},
      },
    })
  );
  expect(disabled).toMatch(/data-testid="resources-toggle"[^>]*disabled/);
});

it("面板开关动作透传给宿主（先例：window-controls-ui 直接调用 props）", () => {
  // renderToStaticMarkup 不执行事件；动作透传经组件 props 直接调用验证。
  const onToggleResources = vi.fn();
  const onToggleChanges = vi.fn();
  const markup = createElement(TitlebarPanelToggles, {
    panels: {
      resourcesOpen: false,
      changesOpen: false,
      disabled: false,
      onToggleResources,
      onToggleChanges,
    },
  });
  markup.props.panels.onToggleResources();
  markup.props.panels.onToggleChanges();
  expect(onToggleResources).toHaveBeenCalledOnce();
  expect(onToggleChanges).toHaveBeenCalledOnce();
});
