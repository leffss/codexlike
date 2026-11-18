// @vitest-environment jsdom
// 新建任务居中起点页（票 01 骨架转正，ADR 0026 变体 A「决策台」）：
// 草稿态主列整体替换为居中起点组件——工作区单独成卡、审批/模型/思考
// 一级呈现、专属输入卡壳（圆形上箭头、空输入禁用）、无 Profile 引导卡。
// 本文件测 NewTaskStart 的 props seam（呈现结构与交互回调），接线到
// WorkspacePage 的端到端行为由 desktop e2e 覆盖（05 号票统一实跑）。
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { NewTaskStart } from "../src/components/NewTaskStart";
import type { NewTaskDraft } from "../src/lib/workspace-state";
import type {
  ApprovalMode,
  ProviderProfile,
  ProjectRecord,
  SkillDescriptor,
} from "@codexlike/agent-core";

const PROFILES: ProviderProfile[] = [
  {
    id: "prof-1",
    name: "GLM",
    baseURL: "https://a",
    apiKey: "k",
    models: ["glm-4.7", "glm-4.7-flash"],
  },
  {
    id: "prof-2",
    name: "DeepSeek",
    baseURL: "https://b",
    apiKey: "k",
    models: ["deepseek-chat"],
  },
];

const PROJECTS: ProjectRecord[] = [
  {
    id: "p1",
    name: "ai-agent",
    workspacePath: "C:\\ws\\ai-agent",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "p2",
    name: "另一个项目",
    workspacePath: "D:\\ws\\another",
    createdAt: "2026-01-02T00:00:00.000Z",
  },
];

function baseDraft(overrides: Partial<NewTaskDraft> = {}): NewTaskDraft {
  return {
    requestId: "req-1",
    projectId: null,
    text: "",
    providerProfileId: "prof-1",
    model: "glm-4.7",
    thinkingEffort: "auto",
    approvalMode: "ask",
    busy: false,
    error: null,
    ...overrides,
  };
}

function baseProps(
  overrides: Partial<Parameters<typeof NewTaskStart>[0]> = {}
): Parameters<typeof NewTaskStart>[0] {
  return {
    draft: baseDraft(),
    projects: PROJECTS,
    profiles: PROFILES,
    workspaceFiles: [],
    onOpenSkills: vi.fn(),
    onEditDraft: vi.fn(),
    onSwitchProject: vi.fn(),
    onSelectWorkspace: vi.fn(),
    onSelectApprovalMode: vi.fn(),
    onSend: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

// jsdom 未实现 scrollIntoView（选择器菜单定位滚动用）：stub 成空函数
// （先例 subagent-rail-switch.test.tsx）
window.HTMLElement.prototype.scrollIntoView = () => {};

describe("NewTaskStart 居中起点页", () => {
  it("项目任务：标题行左侧「新建任务」、右侧归属选择器回显项目名；工作区卡显示项目路径与本地/Worktree 切换，无目录选择入口", () => {
    render(
      createElement(
        NewTaskStart,
        baseProps({ draft: baseDraft({ projectId: "p1" }) })
      )
    );
    expect(screen.getByText("新建任务")).toBeTruthy();
    const selector = screen.getByTestId("draft-project-select");
    expect(selector.getAttribute("data-value")).toBe("p1");
    expect(selector.textContent).toContain("ai-agent");
    expect(screen.getByTestId("workspace-path").textContent).toContain(
      "C:\\ws\\ai-agent"
    );
    expect(screen.getByTestId("draft-workspace-mode")).toBeTruthy();
    expect(screen.queryByTestId("draft-select-workspace")).toBeNull();
    expect(screen.queryByTestId("draft-managed-workspace")).toBeNull();
  });

  it("独立任务（未选目录）：归属选择器初值为独立；专用目录文案 + 「选择已有目录」（点击回调）；无 Worktree 选项（域语义红线）", () => {
    const props = baseProps({ draft: baseDraft({ projectId: null }) });
    render(createElement(NewTaskStart, props));
    expect(
      screen.getByTestId("draft-project-select").getAttribute("data-value")
    ).toBe("standalone");
    expect(screen.getByTestId("workspace-path").textContent).toContain(
      "应用专用持久目录（发送第一条消息后分配）"
    );
    expect(screen.queryByTestId("draft-workspace-mode")).toBeNull();
    expect(screen.queryByTestId("draft-managed-workspace")).toBeNull();
    fireEvent.click(screen.getByTestId("draft-select-workspace"));
    expect(props.onSelectWorkspace).toHaveBeenCalled();
  });

  it("归属选择器（票 02）：列出「不选项目（独立任务）」与全部项目；初始值为进入入口的语境；选择即切换入口回调", () => {
    const props = baseProps({ draft: baseDraft({ projectId: "p1" }) });
    render(createElement(NewTaskStart, props));
    fireEvent.click(screen.getByTestId("draft-project-select"));
    const standaloneOption = screen.getByTestId(
      "draft-project-select-option-standalone"
    );
    expect(standaloneOption.textContent).toContain("不选项目（独立任务）");
    expect(
      screen.getByTestId("draft-project-select-option-p2").textContent
    ).toContain("另一个项目");

    fireEvent.click(standaloneOption);
    expect(props.onSwitchProject).toHaveBeenCalledWith(null);

    // 从独立语境选择项目：回调携带项目 id
    fireEvent.click(screen.getByTestId("draft-project-select"));
    fireEvent.click(screen.getByTestId("draft-project-select-option-p2"));
    expect(props.onSwitchProject).toHaveBeenCalledWith("p2");
  });

  it("归属切换后（上层换新入口草稿 props）：选择器、工作区形态与草稿文字随切换呈现（切换 = 恢复对应入口草稿）", () => {
    const props = baseProps({
      draft: baseDraft({ projectId: "p1", text: "项目入口的文字" }),
    });
    const view = render(createElement(NewTaskStart, props));
    // 切到独立入口：上层恢复独立草稿（文字随持久草稿），已选目录被重置
    view.rerender(
      createElement(
        NewTaskStart,
        baseProps({
          draft: baseDraft({ projectId: null, text: "独立入口的文字" }),
        })
      )
    );
    expect(
      screen.getByTestId("draft-project-select").getAttribute("data-value")
    ).toBe("standalone");
    expect(
      (screen.getByTestId("composer-input") as HTMLTextAreaElement).value
    ).toBe("独立入口的文字");
    expect(screen.getByTestId("workspace-path").textContent).toContain(
      "应用专用持久目录（发送第一条消息后分配）"
    );
    expect(screen.getByTestId("draft-select-workspace")).toBeTruthy();

    // 切回项目入口：项目草稿文字与项目目录恢复
    view.rerender(
      createElement(
        NewTaskStart,
        baseProps({
          draft: baseDraft({ projectId: "p1", text: "项目入口的文字" }),
        })
      )
    );
    expect(
      screen.getByTestId("draft-project-select").getAttribute("data-value")
    ).toBe("p1");
    expect(
      (screen.getByTestId("composer-input") as HTMLTextAreaElement).value
    ).toBe("项目入口的文字");
    expect(screen.getByTestId("workspace-path").textContent).toContain(
      "C:\\ws\\ai-agent"
    );
    expect(screen.getByTestId("draft-workspace-mode")).toBeTruthy();
  });

  it("切到独立时已选目录重置（上层清 workspacePath 重渲染）：工作区行回专用目录默认形态，不残留上次所选目录", () => {
    const view = render(
      createElement(
        NewTaskStart,
        baseProps({
          draft: baseDraft({ projectId: null, workspacePath: "E:\\picked" }),
        })
      )
    );
    expect(screen.getByTestId("draft-managed-workspace")).toBeTruthy();
    view.rerender(
      createElement(
        NewTaskStart,
        baseProps({ draft: baseDraft({ projectId: null }) })
      )
    );
    expect(screen.queryByTestId("draft-managed-workspace")).toBeNull();
    expect(screen.getByTestId("draft-select-workspace")).toBeTruthy();
    expect(screen.getByTestId("workspace-path").textContent).toContain(
      "应用专用持久目录（发送第一条消息后分配）"
    );
  });

  it("独立任务已选目录：显示所选路径与「使用专用目录」回退；回退清空 workspacePath", () => {
    const props = baseProps({
      draft: baseDraft({ projectId: null, workspacePath: "E:\\picked" }),
    });
    render(createElement(NewTaskStart, props));
    expect(screen.getByTestId("workspace-path").textContent).toContain(
      "E:\\picked"
    );
    expect(screen.queryByTestId("draft-select-workspace")).toBeNull();
    const revert = screen.getByTestId("draft-managed-workspace");
    expect(revert.textContent).toContain("使用专用目录");
    fireEvent.click(revert);
    expect(props.onEditDraft).toHaveBeenCalledWith({
      workspacePath: undefined,
    });
  });

  it("项目任务切 Worktree：工作区卡明示来源目录语义", () => {
    render(
      createElement(
        NewTaskStart,
        baseProps({
          draft: baseDraft({ projectId: "p1", workspaceMode: "worktree" }),
        })
      )
    );
    expect(screen.getByText(/来源目录，发送后使用隔离工作区/)).toBeTruthy();
  });

  it("审批/模型/思考三项一级呈现；切换审批走 onSelectApprovalMode（full-access 确认由上层拦截）", () => {
    const props = baseProps();
    render(createElement(NewTaskStart, props));
    const approval = screen.getByTestId("approval-mode-select");
    expect(approval.getAttribute("data-value")).toBe("ask");
    expect(
      screen.getByTestId("profile-select").getAttribute("data-value")
    ).toBe("prof-1::glm-4.7");
    expect(
      screen.getByTestId("thinking-effort-select").getAttribute("data-value")
    ).toBe("auto");

    fireEvent.click(approval);
    fireEvent.click(screen.getByTestId("approval-mode-select-option-assist"));
    expect(props.onSelectApprovalMode).toHaveBeenCalledWith("assist");
  });

  it("切模型/思考写回草稿字段（onEditDraft）", () => {
    const props = baseProps();
    render(createElement(NewTaskStart, props));
    fireEvent.click(screen.getByTestId("profile-select"));
    fireEvent.click(
      screen.getByTestId("profile-select-option-prof-2::deepseek-chat")
    );
    expect(props.onEditDraft).toHaveBeenCalledWith({
      providerProfileId: "prof-2",
      model: "deepseek-chat",
    });

    fireEvent.click(screen.getByTestId("thinking-effort-select"));
    fireEvent.click(screen.getByTestId("thinking-effort-select-option-high"));
    expect(props.onEditDraft).toHaveBeenCalledWith({ thinkingEffort: "high" });
  });

  it("输入卡：placeholder 提示 /·@·$；空输入发送禁用；输入经 onEditDraft 写回、有文字时点击发送回调 onSend", () => {
    const props = baseProps();
    const view = render(createElement(NewTaskStart, props));
    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    expect(input.getAttribute("placeholder")).toContain("$ 技能");
    const send = screen.getByTestId("composer-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "帮我修个 bug" } });
    expect(props.onEditDraft).toHaveBeenCalledWith({ text: "帮我修个 bug" });

    // 受控输入：草稿写回后（上层同步 draft.text）发送按钮启用
    view.rerender(
      createElement(NewTaskStart, {
        ...props,
        draft: baseDraft({ text: "帮我修个 bug" }),
      })
    );
    expect(
      (screen.getByTestId("composer-send") as HTMLButtonElement).disabled
    ).toBe(false);
    fireEvent.click(screen.getByTestId("composer-send"));
    expect(props.onSend).toHaveBeenCalledWith("帮我修个 bug");
  });

  it("busy（首条发送中）：输入只读、发送与工作区操作禁用、归属选择器不可切入口", () => {
    const props = baseProps({
      draft: baseDraft({ projectId: null, text: "首条", busy: true }),
    });
    render(createElement(NewTaskStart, props));
    expect(
      (screen.getByTestId("composer-input") as HTMLTextAreaElement).readOnly
    ).toBe(true);
    expect(
      (screen.getByTestId("composer-send") as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByTestId("draft-select-workspace") as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByTestId("draft-project-select") as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("失败态：draft-error 显示中文提示，输入与设置保留（受控于草稿）", () => {
    render(
      createElement(
        NewTaskStart,
        baseProps({
          draft: baseDraft({
            projectId: null,
            text: "要重发的内容",
            error: "创建失败，可重试：boom",
          }),
        })
      )
    );
    const error = screen.getByTestId("draft-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toContain("创建失败，可重试：boom");
    expect(
      (screen.getByTestId("composer-input") as HTMLTextAreaElement).value
    ).toBe("要重发的内容");
    expect(
      (screen.getByTestId("composer-send") as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("无 Provider Profile：整体替换为配置引导卡（品牌语 + 前往设置），不渲染输入卡", () => {
    const props = baseProps({ profiles: [] });
    render(createElement(NewTaskStart, props));
    const guide = screen.getByTestId("draft-empty-start");
    expect(guide.textContent).toContain("CodexLike");
    // 文案与设置页用户可见语汇一致（「模型接入」），不出现内部术语
    expect(guide.textContent).toContain("尚未配置模型");
    expect(guide.textContent).not.toContain("Provider Profile");
    expect(screen.queryByTestId("composer-input")).toBeNull();
    expect(screen.queryByTestId("draft-workspace-info")).toBeNull();
    fireEvent.click(screen.getByTestId("draft-goto-settings"));
    expect(props.onOpenSettings).toHaveBeenCalled();
  });

  it("空态恢复（票 04）：配置 Profile 后（设置页返回重挂重拉 profiles）起点页整体恢复，引导卡卸载，入口已写文字保留", () => {
    // profiles 空：引导卡占位
    const props = baseProps({
      profiles: [],
      draft: baseDraft({ projectId: null, text: "配置前的文字" }),
    });
    const view = render(createElement(NewTaskStart, props));
    expect(screen.getByTestId("draft-empty-start")).toBeTruthy();

    // 配置 Profile 后返回：WorkspacePage 重挂并重拉 profiles（props 层面
    // 即 profiles 到位重渲染），起点页恢复——标题、工作区卡、输入卡回归，
    // 草稿文字（持久层恢复）不丢
    view.rerender(
      createElement(
        NewTaskStart,
        baseProps({
          draft: baseDraft({ projectId: null, text: "配置前的文字" }),
        })
      )
    );
    expect(screen.queryByTestId("draft-empty-start")).toBeNull();
    expect(screen.getByText("新建任务")).toBeTruthy();
    expect(screen.getByTestId("draft-workspace-info")).toBeTruthy();
    expect(
      (screen.getByTestId("composer-input") as HTMLTextAreaElement).value
    ).toBe("配置前的文字");
  });

  it("输入 `/` 弹命令菜单；输入 `$` 弹技能菜单并触发候选重新发现", () => {
    const skill: SkillDescriptor = {
      name: "tdd",
      description: "红绿循环",
      path: "C:\\skills\\tdd\\SKILL.md",
      directory: "C:\\skills\\tdd",
      scope: "global",
      source: "codexlike",
      status: "active",
    };
    const props = baseProps({ skills: [skill] });
    render(createElement(NewTaskStart, props));
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getByTestId("composer-menu")).toBeTruthy();

    fireEvent.change(input, { target: { value: "$" } });
    expect(screen.getByTestId("composer-menu")).toBeTruthy();
    expect(screen.getByTestId("composer-skill-tdd")).toBeTruthy();
    expect(props.onOpenSkills).toHaveBeenCalled();
  });
});
