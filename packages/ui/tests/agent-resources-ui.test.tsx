import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageComposer } from "../src/components/MessageComposer";
import { AgentResourcesPanel } from "../src/components/AgentResourcesPanel";
import { WorkspacePage } from "../src/pages/WorkspacePage";
import { SettingsPage } from "../src/pages/SettingsPage";
import type { ResourceSnapshotSummary } from "@codexlike/agent-core";

const snapshot: ResourceSnapshotSummary = {
  catalog: {
    capturedAt: "2026-11-11T01:00:00.000Z",
    indexBytes: 100,
    agents: {
      sources: [
        {
          path: "/project/AGENTS.md",
          scope: "project",
          bytes: 40000,
          includedBytes: 32768,
        },
      ],
      truncated: true,
    },
    skills: [
      {
        name: "review",
        description: "审查",
        path: "/project/.agents/skills/review/SKILL.md",
        directory: "/project/.agents/skills/review",
        scope: "project",
        source: "agents",
        status: "active",
      },
      {
        name: "review",
        description: "旧审查",
        path: "/global/skills/review/SKILL.md",
        directory: "/global/skills/review",
        scope: "global",
        source: "codexlike",
        status: "shadowed",
        reason: "被项目覆盖",
      },
      {
        name: "broken",
        description: "",
        path: "/global/skills/broken/SKILL.md",
        directory: "/global/skills/broken",
        scope: "global",
        source: "codexlike",
        status: "invalid",
        reason: "缺少 description",
      },
    ],
    diagnostics: [{ path: "/project/AGENTS.md", message: "总量达到上限" }],
  },
  loaded: [
    {
      executorId: "main",
      name: "review",
      path: "/project/.agents/skills/review/SKILL.md",
      kind: "skill",
      bytes: 300,
    },
    {
      executorId: "child-1",
      name: "review",
      path: "/project/.agents/skills/review/example.txt",
      kind: "resource",
      bytes: 50,
    },
  ],
  estimatedTokens: 1234,
};

describe("规范与技能只读面板", () => {
  it("面板开关与 workspace-info 行随票01迁出工作台页，不再在页内渲染", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspacePage, { onOpenSettings: () => {} })
    );
    // 开关移入标题栏（TitlebarPanelToggles，禁用态见 titlebar-task-context.test），
    // 任务头行与 workspace-info 行整行取消；无任务时草稿收纳行也不渲染。
    expect(html).not.toMatch(/data-testid="resources-toggle"/);
    expect(html).not.toMatch(/data-testid="task-header-content"/);
    expect(html).not.toMatch(/data-testid="workspace-info"/);
    expect(html).not.toMatch(/data-testid="draft-workspace-info"/);
  });
  it("区分运行、最近与预览，展示来源/截断/诊断和分执行者加载而不提供编辑或正文", () => {
    const html = renderToStaticMarkup(
      createElement(AgentResourcesPanel, {
        resources: {
          active: snapshot,
          last: snapshot,
          preview: { ...snapshot, loaded: [] },
        },
        loading: false,
        error: null,
        onClose: () => {},
        onRefresh: () => {},
      })
    );
    for (const text of [
      "resources-panel",
      "当前运行快照",
      "最近一轮摘要",
      "下轮磁盘预览",
      "/project/AGENTS.md",
      "32768",
      "40000",
      "已截断",
      "被项目覆盖",
      "缺少 description",
      "总量达到上限",
      "main",
      "child-1",
      "example.txt",
      "正文",
    ])
      expect(html).toContain(text);
    expect(html).not.toMatch(/<(textarea|input)/);
    expect(html).not.toContain("contenteditable");
  });
});

describe("模型配置入口", () => {
  it("设置页以模型命名配置区和新建入口", () => {
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(html).toMatch(/<h2[^>]*>模型<\/h2>/);
    expect(html).toMatch(
      /<button[^>]*data-testid="profile-create"[^>]*>\+ 新建模型<\/button>/
    );
    expect(html).not.toContain("Provider Profile");
    expect(html).not.toContain("新建 Profile");
  });
  it("工作区未配置模型时使用中文提示和设置入口", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspacePage, { onOpenSettings: () => {} })
    );
    expect(html).toContain("尚未配置模型，请先前往设置页添加模型");
    expect(html).toContain("前往设置配置模型");
    expect(html).not.toContain("Provider Profile");
  });
});

describe("技能输入入口", () => {
  it("审批模式分别显示盾牌问号、盾牌勾和警示色解锁图标", () => {
    const cases = [
      {
        mode: "ask",
        label: "请求批准",
        shape: 'd="M6.5 6a1.5 1.5 0 0 1 3 0c0 1-1.5 1-1.5 2"',
      },
      {
        mode: "assist",
        label: "帮我批准",
        shape: 'd="m5.5 7.5 1.5 1.5 3.5-3.5"',
      },
      {
        mode: "full-access",
        label: "完全访问",
        shape: 'd="M6 7V4a3 3 0 0 1 6 0"',
      },
    ] as const;
    const icons: string[] = [];
    for (const { mode, label, shape } of cases) {
      const html = renderToStaticMarkup(
        createElement(MessageComposer, {
          profiles: [],
          selectedProfileId: "",
          onSelectProfile: () => {},
          onSend: () => {},
          workspaceFiles: [],
          disabled: false,
          hint: "",
          approvalMode: mode,
          onSelectApprovalMode: () => {},
          thinkingEffort: "auto",
          onSelectThinkingEffort: () => {},
        })
      );
      const trigger = html.match(
        /<button[^>]*data-testid="approval-mode-select"[^>]*>[\s\S]*?<\/button>/
      )?.[0];
      expect(trigger).toContain(label);
      const icon = trigger?.match(/<svg[\s\S]*?<\/svg>/)?.[0];
      expect(icon).toContain('aria-hidden="true"');
      expect(icon).toContain(shape);
      expect(icon?.includes("text-warn-fg")).toBe(mode === "full-access");
      icons.push(icon!);
    }
    expect(new Set(icons).size).toBe(3);
  });
  it("普通输入从任务草稿恢复，即使禁用发送仍保留输入内容与停止按钮", () => {
    const html = renderToStaticMarkup(
      createElement(MessageComposer, {
        profiles: [],
        selectedProfileId: "",
        onSelectProfile: () => {},
        onSend: () => {},
        workspaceFiles: [],
        disabled: true,
        hint: "",
        approvalMode: "assist",
        onSelectApprovalMode: () => {},
        thinkingEffort: "auto",
        onSelectThinkingEffort: () => {},
        draftValue: "切任务前的输入",
        onDraftChange: () => {},
        streaming: true,
      })
    );
    expect(html).toContain("切任务前的输入");
    expect(html).toContain("flex flex-wrap items-center justify-between");
    expect(html).toContain("composer-stop");
    expect(html).not.toContain("composer-send");
  });
  it("按模型、思考档位、技能排列，模型使用不提交表单的 combobox", () => {
    const html = renderToStaticMarkup(
      createElement(MessageComposer, {
        profiles: [],
        selectedProfileId: "",
        onSelectProfile: () => {},
        onSend: () => {},
        workspaceFiles: [],
        disabled: false,
        hint: "",
        approvalMode: "assist",
        onSelectApprovalMode: () => {},
        thinkingEffort: "auto",
        onSelectThinkingEffort: () => {},
      })
    );
    expect(html).toMatch(
      /<button[^>]*type="button"[^>]*role="combobox"[^>]*aria-label="模型"[^>]*data-testid="profile-select"/
    );
    const controls = [
      "approval-mode-select",
      "profile-select",
      "thinking-effort-select",
      "composer-skills",
      "composer-send",
    ];
    const positions = controls.map((id) => html.indexOf(`data-testid="${id}"`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain("未配置模型");
  });
  it.each([false, true])(
    "只读=%s 时保留失效模型提示与选择器禁用规则",
    (readOnly) => {
      const html = renderToStaticMarkup(
        createElement(MessageComposer, {
          profiles: [
            {
              id: "available",
              name: "可用模型",
              model: "test-model",
              baseURL: "http://localhost/v1",
              apiKey: "",
            },
          ],
          selectedProfileId: "removed",
          onSelectProfile: () => {},
          onSend: () => {},
          workspaceFiles: [],
          disabled: true,
          readOnly,
          streaming: true,
          hint: "",
          approvalMode: "assist",
          onSelectApprovalMode: () => {},
          thinkingEffort: "high",
          onSelectThinkingEffort: () => {},
        })
      );
      expect(html).toContain("已保存的模型不可用");
      expect(html).not.toContain("可用模型 · test-model");
      expect(html).toContain('data-value="removed"');
      for (const id of [
        "profile-select",
        "thinking-effort-select",
        "composer-skills",
      ]) {
        const button = html.match(
          new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`)
        )?.[0];
        expect(button).toBeDefined();
        expect(button?.includes('disabled=""')).toBe(readOnly);
      }
      expect(html).toContain("composer-stop");
    }
  );
  it("提供不提交表单的技能按钮", () => {
    const html = renderToStaticMarkup(
      createElement(MessageComposer, {
        profiles: [],
        selectedProfileId: "",
        onSelectProfile: () => {},
        onSend: () => {},
        workspaceFiles: [],
        disabled: false,
        hint: "",
        approvalMode: "assist",
        onSelectApprovalMode: () => {},
        thinkingEffort: "auto",
        onSelectThinkingEffort: () => {},
      })
    );
    expect(html).toMatch(
      /<button[^>]*type="button"[^>]*data-testid="composer-skills"/
    );
    expect(html).toContain("技能");
  });
});
