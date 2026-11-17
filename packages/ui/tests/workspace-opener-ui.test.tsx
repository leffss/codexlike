// @vitest-environment jsdom
// 工作区打开器分裂按钮（GLOSSARY「工作区打开器」）：候选/打开经 context
// 注入（page 层绑 IPC），SSR 静态断言测不到展开拉取与点选回路，用
// jsdom + testing-library 驱动真实点击，锁定「点选即打开并记默认、
// 失败提示不改默认」的行为。
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import {
  TitlebarTaskContext,
  type TitlebarContext,
} from "../src/components/TitlebarTaskContext";
import type {
  OpenerListResult,
  OpenerOpenResult,
} from "@codexlike/desktop/ipc";

function openerList(
  overrides: Partial<OpenerListResult> = {}
): OpenerListResult {
  return {
    openers: [
      { id: "explorer", label: "资源管理器" },
      { id: "vscode", label: "VS Code" },
    ],
    defaultId: "explorer",
    ...overrides,
  };
}

function openResult(
  defaultId: OpenerOpenResult["defaultId"]
): OpenerOpenResult {
  return { defaultId };
}

function context(
  openerOverrides: Record<string, unknown> = {}
): TitlebarContext {
  return {
    task: {
      taskId: "task-1",
      title: "实现打开器",
      projectName: "ai-agent",
      workspaceMode: "local",
      workspacePath: "C:\\ws\\demo",
      workspaceOriginPath: null,
    },
    panels: {
      open: false,
      disabled: false,
      onToggle: () => {},
      changesCount: null,
    },
    opener: {
      workspacePath: "C:\\ws\\demo",
      listOpeners: vi.fn(async () => openerList()),
      openWorkspace: vi.fn(async () => openResult("explorer")),
      notifyError: vi.fn(),
      ...openerOverrides,
    },
  };
}

/** 主按钮内限定查图标（默认项图标与菜单项共用定位器，须按容器限定） */
function mainIcon(id: string): Element | null {
  return screen
    .getByTestId("workspace-opener-main")
    .querySelector(`[data-testid="workspace-opener-icon-${id}"]`);
}

afterEach(() => cleanup());

describe("WorkspaceOpenerButton 分裂按钮", () => {
  it("挂载预取默认：主按钮图标跟随；点选后图标随新默认切换", async () => {
    const ctx = context();
    render(createElement(TitlebarTaskContext, { context: ctx }));
    await waitFor(() => {
      expect(mainIcon("explorer")).toBeTruthy();
    });
    // 挂载只拉一次（菜单未展开）
    expect(ctx.opener.listOpeners).toHaveBeenCalledTimes(1);
  });

  it("展开下拉拉取候选，默认项带 ✓；点选即打开并记默认、收起菜单、主按钮图标切换", async () => {
    const ctx = context({
      openWorkspace: vi.fn(async () => openResult("vscode")),
    });
    render(createElement(TitlebarTaskContext, { context: ctx }));
    expect(screen.queryByTestId("workspace-opener-menu")).toBeNull();

    fireEvent.click(screen.getByTestId("workspace-opener-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("workspace-opener-menu")).toBeTruthy();
    });
    // 挂载预取（1）+ 展开重拉（2）
    expect(ctx.opener.listOpeners).toHaveBeenCalledTimes(2);
    expect(
      screen.getByTestId("workspace-opener-option-explorer").textContent
    ).toContain("资源管理器");
    expect(
      screen.getByTestId("workspace-opener-option-vscode").textContent
    ).toContain("VS Code");
    // 默认 explorer 带 ✓，vscode 不带
    expect(screen.getByTestId("workspace-opener-check-explorer")).toBeTruthy();
    expect(screen.queryByTestId("workspace-opener-check-vscode")).toBeNull();

    fireEvent.click(screen.getByTestId("workspace-opener-option-vscode"));
    await waitFor(() => {
      expect(ctx.opener.openWorkspace).toHaveBeenCalledWith({
        workspacePath: "C:\\ws\\demo",
        openerId: "vscode",
      });
    });
    // 点选后收起
    await waitFor(() => {
      expect(screen.queryByTestId("workspace-opener-menu")).toBeNull();
    });
    // 主按钮图标切到新默认 vscode（用户定稿：图标跟随默认）
    await waitFor(() => {
      expect(mainIcon("vscode")).toBeTruthy();
    });
    expect(mainIcon("explorer")).toBeNull();
  });

  it("主按钮不带 openerId 用默认打开；打开失败提示、不改本地默认", async () => {
    // 行为经标志位切换：组件渲染时已解构注入函数，事后改写不生效
    let failOpen = false;
    const ctx = context({
      openWorkspace: vi.fn(async () => {
        if (failOpen) throw new Error("VS Code 未检测到，无法打开");
        return openResult("explorer");
      }),
    });
    render(createElement(TitlebarTaskContext, { context: ctx }));
    fireEvent.click(screen.getByTestId("workspace-opener-main"));
    await waitFor(() => {
      expect(ctx.opener.openWorkspace).toHaveBeenCalledWith({
        workspacePath: "C:\\ws\\demo",
      });
    });
    expect(ctx.opener.notifyError).not.toHaveBeenCalled();

    failOpen = true;
    fireEvent.click(screen.getByTestId("workspace-opener-main"));
    await waitFor(() => {
      expect(ctx.opener.notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/未检测到/)
      );
    });
  });

  it("候选拉取失败：提示且不展开菜单", async () => {
    const ctx = context({
      listOpeners: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    render(createElement(TitlebarTaskContext, { context: ctx }));
    fireEvent.click(screen.getByTestId("workspace-opener-toggle"));
    await waitFor(() => {
      expect(ctx.opener.notifyError).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("workspace-opener-menu")).toBeNull();
  });

  it("无工作区路径（无任务且草稿未选目录）：主按钮与下拉禁用、不预取列表，提示未选择工作区", () => {
    const ctx = context({ workspacePath: null });
    render(createElement(TitlebarTaskContext, { context: ctx }));
    const main = screen.getByTestId(
      "workspace-opener-main"
    ) as HTMLButtonElement;
    const toggle = screen.getByTestId(
      "workspace-opener-toggle"
    ) as HTMLButtonElement;
    expect(main.disabled).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(main.title).toBe("未选择工作区");
    expect(ctx.opener.listOpeners).not.toHaveBeenCalled();
  });

  it("Escape 收起下拉", async () => {
    const ctx = context();
    render(createElement(TitlebarTaskContext, { context: ctx }));
    fireEvent.click(screen.getByTestId("workspace-opener-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("workspace-opener-menu")).toBeTruthy();
    });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("workspace-opener-menu")).toBeNull();
    });
  });
});
