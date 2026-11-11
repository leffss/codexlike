import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageComposer } from "../src/components/MessageComposer";
import { AgentResourcesPanel } from "../src/components/AgentResourcesPanel";
import { WorkspacePage } from "../src/pages/WorkspacePage";
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
  it("工作区顶栏提供规范与技能只读入口，无会话时禁用", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspacePage, { onOpenSettings: () => {} })
    );
    expect(html).toMatch(
      /<button[^>]*data-testid="resources-toggle"[^>]*disabled/
    );
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

describe("技能输入入口", () => {
  it("普通输入从会话草稿恢复，即使禁用发送仍保留输入内容与停止按钮", () => {
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
        draftValue: "切会话前的输入",
        onDraftChange: () => {},
        streaming: true,
      })
    );
    expect(html).toContain("切会话前的输入");
    expect(html).toContain("flex flex-wrap items-center justify-between");
    expect(html).toContain("composer-stop");
    expect(html).not.toContain("composer-send");
  });
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
