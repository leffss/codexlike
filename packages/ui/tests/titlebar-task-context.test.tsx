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
    panels: {
      open: false,
      disabled: false,
      onToggle: () => {},
      changesCount: null,
    },
    // 工作区打开器：静态断言只关渲染，注入空实现（交互见 workspace-opener-ui）
    opener: {
      workspacePath: task().workspacePath,
      listOpeners: async () => ({ openers: [], defaultId: "explorer" }),
      openWorkspace: async () => ({ defaultId: "explorer" }),
      notifyError: () => {},
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
  // 任务搜索已迁任务列表头部（ADR 0018），标题栏左区不再渲染
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

it("「右栏开关」保留定位器并同步 aria 状态，无任务且草稿无工作区时禁用", () => {
  const open = renderToStaticMarkup(
    createElement(TitlebarResourceToggle, {
      panels: {
        open: true,
        disabled: false,
        onToggle: () => {},
        changesCount: null,
      },
    })
  );
  expect(open).toMatch(
    /data-testid="resources-toggle"[^>]*aria-expanded="true"/
  );
  const closed = renderToStaticMarkup(
    createElement(TitlebarResourceToggle, {
      panels: {
        open: false,
        disabled: false,
        onToggle: () => {},
        changesCount: null,
      },
    })
  );
  expect(closed).toMatch(
    /data-testid="resources-toggle"[^>]*aria-expanded="false"/
  );
  const disabled = renderToStaticMarkup(
    createElement(TitlebarResourceToggle, {
      panels: {
        open: false,
        disabled: true,
        onToggle: () => {},
        changesCount: null,
      },
    })
  );
  expect(disabled).toMatch(/data-testid="resources-toggle"[^>]*disabled/);
});

it("「右栏开关」：展开态高亮（accent），panel 图标承载语义", () => {
  const open = renderToStaticMarkup(
    createElement(TitlebarResourceToggle, {
      panels: {
        open: true,
        disabled: false,
        onToggle: () => {},
        changesCount: null,
      },
    })
  );
  const button = open.match(
    /<button[^>]*data-testid="resources-toggle"[^>]*>[\s\S]*?<\/button>/
  )?.[0];
  // 持久高亮 = 暖灰底 + 字重（D 语言激活语汇，非 hover 类）
  expect(button).toContain("bg-surface-muted font-semibold");
  expect(button).toContain('aria-label="右栏开关"');
  expect(button).toContain('title="收起右栏"');
  expect(button).toMatch(/<svg[^>]*aria-hidden="true"/);
  expect(button).not.toContain(">右栏开关<");
  const closed = renderToStaticMarkup(
    createElement(TitlebarResourceToggle, {
      panels: {
        open: false,
        disabled: false,
        onToggle: () => {},
        changesCount: null,
      },
    })
  );
  expect(closed).not.toContain("bg-surface-muted");
  expect(closed).toContain('title="展开右栏"');
});

it("未提交变更角标：>0 显示精确数并入无障碍名，0/null 不渲染（ADR 0018）", () => {
  const withCount = renderToStaticMarkup(
    createElement(TitlebarResourceToggle, {
      panels: {
        open: false,
        disabled: false,
        onToggle: () => {},
        changesCount: 7,
      },
    })
  );
  expect(withCount).toMatch(
    /data-testid="resources-toggle-badge"[^>]*>\s*7\s*</
  );
  expect(withCount).toContain('aria-label="右栏开关，7 个文件改动"');
  // 99+ 截断：角标紧凑提醒位折叠，精确数在右栏「改动」tab
  const capped = renderToStaticMarkup(
    createElement(TitlebarResourceToggle, {
      panels: {
        open: false,
        disabled: false,
        onToggle: () => {},
        changesCount: 120,
      },
    })
  );
  expect(capped).toMatch(
    /data-testid="resources-toggle-badge"[^>]*>\s*99\+\s*</
  );
  // 0 与 null 都不渲染角标
  for (const changesCount of [0, null]) {
    const empty = renderToStaticMarkup(
      createElement(TitlebarResourceToggle, {
        panels: {
          open: false,
          disabled: false,
          onToggle: () => {},
          changesCount,
        },
      })
    );
    expect(empty).not.toMatch(/resources-toggle-badge/);
    expect(empty).toContain('aria-label="右栏开关"');
  }
});

it("拖动区按控件归属划分（审查修复 1）：徽章与打开器免拖，任务名可拖", () => {
  const html = renderToStaticMarkup(
    createElement(TitlebarTaskContext, { context: context() })
  );
  // 只有交互控件挂在 window-no-drag 作用域内：徽章容器（含点击弹层）与
  // 「工作区打开器」分裂按钮（含下拉菜单）各一个。
  // 真实拖拽行为由 window-controls 场景以系统级输入验证（品牌回退态），
  // 任务态划分以此静态断言兜底。
  expect(html.match(/<div class="window-no-drag/g)).toHaveLength(2);
  expect(html).toMatch(/data-testid="workspace-opener-main"/);
  // 任务名与品牌是纯展示文本：不落入免拖作用域，跟随父级标题栏拖动
  const titleTag =
    html.match(/<span[^>]*data-testid="task-title"[^>]*>/)?.[0] ?? "";
  expect(titleTag).not.toContain("window-no-drag");
  const brandTag = html.match(/<span[^>]*>CodexLike<\/span>/)?.[0] ?? "";
  expect(brandTag).not.toContain("window-no-drag");
});

it("右栏开关动作透传给宿主（先例：window-controls-ui 直接调用 props）", () => {
  // renderToStaticMarkup 不执行事件；动作透传经组件 props 直接调用验证。
  const onToggle = vi.fn();
  const markup = createElement(TitlebarResourceToggle, {
    panels: {
      open: false,
      disabled: false,
      onToggle,
      changesCount: null,
    },
  });
  markup.props.panels.onToggle();
  expect(onToggle).toHaveBeenCalledOnce();
});
