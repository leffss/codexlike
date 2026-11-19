// @vitest-environment jsdom
// 票06 弹层家族 D 语汇（ADR 0028）：白卡 + line 发丝线 + 四档阴影 token + 10/12px 圆角。
// 断言只锁「语汇类名」这一层——定位/开合/键盘导航行为归各自行为测试，此处不重复。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProviderProfile } from "@codexlike/agent-core";
import type { ExitState, TaskListItem } from "@codexlike/desktop/ipc";
import { ModelThinkingSelect } from "../src/components/ModelThinkingSelect";
import { ComposerSelect } from "../src/components/ComposerSelect";
import { TaskContextMenu } from "../src/components/TaskContextMenu";
import { TaskSearch } from "../src/components/TaskSearch";
import { FullAccessConfirmDialog } from "../src/components/FullAccessConfirmDialog";
import {
  MembershipDialog,
  ProjectRemovalDialog,
} from "../src/components/MembershipDialogs";
import { ApplicationExit } from "../src/components/ApplicationExit";
import { ToastHost } from "../src/components/ToastHost";
import {
  TitlebarTaskContext,
  WorkspaceBadgePopover,
  type TitlebarContext,
  type TitlebarTask,
} from "../src/components/TitlebarTaskContext";

// jsdom 未实现 ResizeObserver（定位 hook 观察 trigger 用）与 scrollIntoView：
// 空 stub（先例 model-thinking-select-ui / workspace-queue-ui）
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("弹层家族：白卡 + 发丝线 + shadow-popover + 10px 圆角", () => {
  it("model-thinking-popover：220px 宽度纪律与白卡语汇并存，不再手写 shadow-lg", () => {
    const profiles: ProviderProfile[] = [
      {
        id: "p1",
        name: "GLM",
        models: ["glm-4.7"],
        baseURL: "https://a",
        apiKey: "k",
      },
    ];
    render(
      createElement(ModelThinkingSelect, {
        profiles,
        selectedProfileId: "p1",
        selectedModel: "glm-4.7",
        thinkingEffort: "low",
        onSelectModel: () => {},
        onSelectThinkingEffort: () => {},
      })
    );
    fireEvent.click(screen.getByTestId("model-thinking-select"));
    const popover = screen.getByTestId<HTMLDivElement>(
      "model-thinking-popover"
    );
    expect(popover.className).toContain("w-[220px]"); // e2e 宽度上限断言的锚
    expect(popover.className).toContain("bg-surface");
    expect(popover.className).toContain("border-line");
    expect(popover.className).toContain("rounded-[10px]");
    expect(popover.className).toContain("shadow-popover");
    expect(popover.className).not.toContain("shadow-lg");
  });

  it("composer 通用下拉 listbox：同一弹层语汇", () => {
    render(
      createElement(ComposerSelect, {
        testId: "kind-select",
        label: "类别",
        value: "a",
        options: [
          { value: "a", label: "甲", title: "甲" },
          { value: "b", label: "乙", title: "乙" },
        ],
        onSelect: () => {},
      })
    );
    fireEvent.click(screen.getByTestId("kind-select"));
    const listbox = screen.getByTestId("kind-select-listbox");
    expect(listbox.className).toContain("bg-surface");
    expect(listbox.className).toContain("border-line");
    expect(listbox.className).toContain("rounded-[10px]");
    expect(listbox.className).toContain("shadow-popover");
    expect(listbox.className).not.toContain("shadow-lg");
  });

  it("task-context-menu：同一弹层语汇", () => {
    render(
      createElement(TaskContextMenu, {
        anchor: { x: 10, y: 10, target: document.body },
        items: [{ testId: "menu-rename", label: "重命名", onSelect: () => {} }],
        onClose: () => {},
      })
    );
    const menu = screen.getByTestId("task-context-menu");
    expect(menu.className).toContain("bg-surface");
    expect(menu.className).toContain("border-line");
    expect(menu.className).toContain("rounded-[10px]");
    expect(menu.className).toContain("shadow-popover");
    expect(menu.className).not.toContain("shadow-lg");
  });

  it("任务搜索浮层：同一弹层语汇", () => {
    render(
      createElement(TaskSearch, { onSelect: () => {}, recordsRevision: 0 })
    );
    fireEvent.click(screen.getByTestId("task-search-toggle"));
    const panel = screen.getByLabelText("跨项目任务搜索");
    expect(panel.className).toContain("bg-surface");
    expect(panel.className).toContain("border-line");
    expect(panel.className).toContain("rounded-[10px]");
    expect(panel.className).toContain("shadow-popover");
    expect(panel.className).not.toContain("shadow-xl");
  });
});

describe("确认对话框全家：白卡 12px 圆角 + shadow-modal（去边框去 shadow-xl）", () => {
  it("full-access-confirm-dialog 模态卡", () => {
    render(
      createElement(FullAccessConfirmDialog, {
        onConfirm: () => {},
        onCancel: () => {},
      })
    );
    const card = screen
      .getByTestId("full-access-confirm-dialog")
      .querySelector<HTMLDivElement>(":scope > div");
    expect(card).not.toBeNull();
    expect(card!.className).toContain("bg-surface");
    expect(card!.className).toContain("rounded-xl"); // 12px 模态档
    expect(card!.className).toContain("shadow-modal");
    expect(card!.className).not.toContain("shadow-xl");
    expect(card!.className).not.toContain("border"); // 模态卡无边框（层次靠投影）
  });

  it("membership-dialog 与 project-removal-dialog 模态卡", () => {
    const task = {
      id: "t1",
      title: "任务一",
      projectId: null,
      workspacePath: "C:/w/t1",
      workspaceMode: "local",
      workspaceOriginPath: null,
      providerProfileId: "p1",
      model: "m",
      approvalMode: "ask",
      status: "idle",
      archivedAt: null,
      createdAt: "2026-11-19T08:00:00Z",
      updatedAt: "2026-11-19T08:00:00Z",
      activity: {
        running: false,
        waitingForUser: false,
        outcome: null,
        unread: false,
      },
    } as unknown as TaskListItem;
    const { unmount } = render(
      createElement(MembershipDialog, {
        task,
        projects: [],
        onClose: () => {},
        onChanged: async () => {},
      })
    );
    const membership = screen.getByTestId("membership-dialog");
    expect(membership.className).toContain("bg-surface");
    expect(membership.className).toContain("rounded-xl");
    expect(membership.className).toContain("shadow-modal");
    expect(membership.className).not.toContain("shadow-xl");
    expect(membership.className).not.toContain("border");
    unmount();

    render(
      createElement(ProjectRemovalDialog, {
        project: {
          id: "proj",
          name: "项目",
          workspacePath: "C:/w",
          createdAt: "2026-11-19T08:00:00Z",
        },
        memberCount: 2,
        onClose: () => {},
        onRemoved: async () => {},
      })
    );
    const removal = screen.getByTestId("project-removal-dialog");
    expect(removal.className).toContain("rounded-xl");
    expect(removal.className).toContain("shadow-modal");
    expect(removal.className).not.toContain("shadow-xl");
    expect(removal.className).not.toContain("border");
  });

  it("ApplicationExit 退出确认冻结层与退出错误角标同走模态档", async () => {
    function stubExit(state: ExitState) {
      vi.stubGlobal("codexlike", {
        application: {
          exitState: vi.fn(async () => state),
          flushed: vi.fn(async () => {}),
          onExitState: () => () => {},
          answerExit: vi.fn(async () => {}),
        },
      });
    }
    stubExit({ id: "exit-1", phase: "confirming" });
    const { unmount } = render(
      createElement(ApplicationExit, {
        state: { flush: vi.fn() } as never,
        children: null,
      })
    );
    const section = await screen.findByLabelText("退出应用");
    expect(section.className).toContain("bg-surface");
    expect(section.className).toContain("rounded-xl");
    expect(section.className).toContain("shadow-modal");
    expect(section.className).not.toContain("shadow-xl");
    expect(section.className).not.toContain("border");
    unmount();

    stubExit({ id: "exit-1", phase: "error", error: "保存失败" });
    render(
      createElement(ApplicationExit, {
        state: { flush: vi.fn() } as never,
        children: null,
      })
    );
    const errorCard = await screen.findByTestId("exit-error");
    expect(errorCard.className).toContain("rounded-xl");
    expect(errorCard.className).toContain("shadow-modal");
    expect(errorCard.className).not.toContain("shadow-xl");
    expect(errorCard.className).not.toContain("border");
  });
});

describe("标题栏两个漏网弹层（票 02 转办）：同走弹层统一语汇", () => {
  const badgeTask: TitlebarTask = {
    taskId: "task-1",
    title: "重构主窗口布局",
    projectName: "ai-agent",
    workspaceMode: "worktree",
    workspacePath: "C:\\Users\\leffss\\.codexlike\\worktrees\\task-1",
    workspaceOriginPath: "C:\\Users\\leffss\\Desktop\\ai-agent",
  };

  it("workspace-popover（工作区徽章弹层）：白卡语汇，不再 shadow-xl", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceBadgePopover, { task: badgeTask })
    );
    const card = html.match(/data-testid="workspace-popover"[^>]*/)?.[0] ?? "";
    expect(card).toContain("bg-surface");
    expect(card).toContain("border-line");
    expect(card).toContain("rounded-[10px]");
    expect(html).toContain("shadow-popover");
    expect(html).not.toContain("shadow-xl");
  });

  it("workspace-opener-menu（工作区打开器菜单）：白卡语汇，不再 shadow-xl", async () => {
    const contextValue: TitlebarContext = {
      task: badgeTask,
      panels: {
        open: false,
        disabled: false,
        onToggle: () => {},
        changesCount: null,
      },
      opener: {
        workspacePath: badgeTask.workspacePath,
        listOpeners: async () => ({
          openers: [
            { id: "explorer", label: "资源管理器" },
            { id: "vscode", label: "VS Code" },
          ],
          defaultId: "explorer",
        }),
        openWorkspace: async () => ({ defaultId: "explorer" }),
        notifyError: () => {},
      },
    };
    render(createElement(TitlebarTaskContext, { context: contextValue }));
    fireEvent.click(screen.getByTestId("workspace-opener-toggle"));
    const menu = await screen.findByTestId("workspace-opener-menu");
    expect(menu.className).toContain("bg-surface");
    expect(menu.className).toContain("border-line");
    expect(menu.className).toContain("rounded-[10px]");
    expect(menu.className).toContain("shadow-popover");
    expect(menu.className).not.toContain("shadow-xl");
  });
});

describe("toast：中性 hairline 白卡 + shadow-toast，类别语义色保留", () => {
  it("三 kind 条目统一 hairline 白卡语汇，底色/文字/圆点保留类别语义", () => {
    render(
      createElement(ToastHost, {
        toasts: [
          {
            id: "context-warning",
            key: "context-warning\nx",
            kind: "warn",
            content: "上下文用量约为窗口的 82%",
          },
          {
            id: "workbench-save-error",
            key: "workbench-save-error\nx",
            kind: "error",
            content: "工作现场保存失败：磁盘已满",
          },
          {
            id: "workspace-sharing-notice",
            key: "workspace-sharing-notice\nx",
            kind: "info",
            content: "另有 1 个运行中任务",
          },
        ],
        onDismiss: () => {},
      })
    );
    for (const id of [
      "context-warning",
      "workbench-save-error",
      "workspace-sharing-notice",
    ]) {
      const card = screen.getByTestId(id);
      expect(card.className).toContain("border-line"); // 中性发丝线（不再类别色描边）
      expect(card.className).toContain("rounded-[10px]");
      expect(card.className).toContain("shadow-toast");
      expect(card.className).not.toContain("shadow-lg");
    }
    expect(screen.getByTestId("context-warning").className).toContain(
      "bg-warn-bg"
    );
    expect(screen.getByTestId("workbench-save-error").className).toContain(
      "bg-danger-bg"
    );
    expect(screen.getByTestId("workspace-sharing-notice").className).toContain(
      "bg-surface"
    );
  });
});
