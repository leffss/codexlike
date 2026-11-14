import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { TaskSearch } from "../src/components/TaskSearch";
import {
  TitlebarResourceToggle,
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
      disabled: false,
      onToggleResources: () => {},
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
  // 任务搜索已迁出左区（App Header 右侧 nav 图标入口），左区不再渲染
  expect(html).not.toMatch(/data-testid="task-search-toggle"/);
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
});

it("任务搜索图标入口：放大镜承载语义，文案进无障碍名，装饰 SVG 不进入无障碍树", () => {
  const html = renderToStaticMarkup(
    createElement(TaskSearch, {
      recordsRevision: 0,
      onSelect: () => {},
    })
  );
  const button = html.match(
    /<button[^>]*data-testid="task-search-toggle"[^>]*>[\s\S]*?<\/button>/
  )?.[0];
  expect(button).toContain('aria-label="搜索任务"');
  expect(button).toContain('title="搜索任务"');
  expect(button).toContain('aria-expanded="false"');
  expect(button).toMatch(/<svg[^>]*aria-hidden="true"/);
  expect(button).not.toContain(">搜索任务<");
  expect(button).not.toContain(">关闭搜索<");
});

it("「规范与技能」图标开关保留定位器并同步 aria 状态，无任务时禁用", () => {
  const open = renderToStaticMarkup(
    createElement(TitlebarResourceToggle, {
      panels: {
        resourcesOpen: true,
        disabled: false,
        onToggleResources: () => {},
      },
    })
  );
  expect(open).toMatch(
    /data-testid="resources-toggle"[^>]*aria-expanded="true"/
  );
  const closed = renderToStaticMarkup(
    createElement(TitlebarResourceToggle, {
      panels: {
        resourcesOpen: false,
        disabled: false,
        onToggleResources: () => {},
      },
    })
  );
  expect(closed).toMatch(
    /data-testid="resources-toggle"[^>]*aria-expanded="false"/
  );
  const disabled = renderToStaticMarkup(
    createElement(TitlebarResourceToggle, {
      panels: {
        resourcesOpen: false,
        disabled: true,
        onToggleResources: () => {},
      },
    })
  );
  expect(disabled).toMatch(/data-testid="resources-toggle"[^>]*disabled/);
});

it("「规范与技能」图标开关：打开态高亮（accent），图标承载语义", () => {
  const open = renderToStaticMarkup(
    createElement(TitlebarResourceToggle, {
      panels: {
        resourcesOpen: true,
        disabled: false,
        onToggleResources: () => {},
      },
    })
  );
  const button = open.match(
    /<button[^>]*data-testid="resources-toggle"[^>]*>[\s\S]*?<\/button>/
  )?.[0];
  // 持久高亮 = 非前缀的 `border-accent text-accent`（与 hover 类区分）
  expect(button).toContain("border-accent text-accent");
  expect(button).toContain('aria-label="规范与技能"');
  expect(button).toContain('title="规范与技能"');
  expect(button).toMatch(/<svg[^>]*aria-hidden="true"/);
  expect(button).not.toContain(">规范与技能<");
  const closed = renderToStaticMarkup(
    createElement(TitlebarResourceToggle, {
      panels: {
        resourcesOpen: false,
        disabled: false,
        onToggleResources: () => {},
      },
    })
  );
  expect(closed).not.toContain("border-accent text-accent");
});

it("拖动区按控件归属划分（审查修复 1）：徽章免拖，任务名可拖", () => {
  const html = renderToStaticMarkup(
    createElement(TitlebarTaskContext, { context: context() })
  );
  // 只有交互控件挂在 window-no-drag 作用域内：徽章容器（含点击弹层）一个；
  // 任务搜索迁入右侧 nav（nav 整体免拖），左区仅剩徽章。真实拖拽行为由
  // window-controls 场景以系统级输入验证（品牌回退态），任务态划分以此静态断言兜底。
  expect(html.match(/<div class="window-no-drag/g)).toHaveLength(1);
  // 任务名与品牌是纯展示文本：不落入免拖作用域，跟随父级标题栏拖动
  const titleTag =
    html.match(/<span[^>]*data-testid="task-title"[^>]*>/)?.[0] ?? "";
  expect(titleTag).not.toContain("window-no-drag");
  const brandTag = html.match(/<span[^>]*>CodexLike<\/span>/)?.[0] ?? "";
  expect(brandTag).not.toContain("window-no-drag");
});

it("面板开关动作透传给宿主（先例：window-controls-ui 直接调用 props）", () => {
  // renderToStaticMarkup 不执行事件；动作透传经组件 props 直接调用验证。
  const onToggleResources = vi.fn();
  const markup = createElement(TitlebarResourceToggle, {
    panels: {
      resourcesOpen: false,
      disabled: false,
      onToggleResources,
    },
  });
  markup.props.panels.onToggleResources();
  expect(onToggleResources).toHaveBeenCalledOnce();
});
