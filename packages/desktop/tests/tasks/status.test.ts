import { describe, expect, it } from "vitest";

import { buildTaskStatus, type TaskStatusInfo } from "../../src/tasks/status";
import type { AgentsMdDiscovery } from "@codexlike/agent-core/node";
import type { TaskRecord, StoredMessage } from "@codexlike/agent-core";

/** 工单 07：/status 的数据组装（token 估算 = 系统提示 + user/assistant 消息） */
function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "s1",
    title: "demo",
    workspacePath: "C:\\work\\demo",
    providerProfileId: "profile-1",
    model: "glm-4.7",
    status: "idle",
    workspaceMode: "local",
    projectId: null,
    workspaceOriginPath: null,
    approvalMode: "assist",
    archivedAt: null,
    createdAt: "2026-11-10T08:00:00.000Z",
    updatedAt: "2026-11-10T08:00:00.000Z",
    ...overrides,
  };
}

const emptyDiscovery: AgentsMdDiscovery = {
  sections: [],
  combined: "",
  truncated: false,
};

const messages: StoredMessage[] = [
  { id: "m1", sessionId: "s1", role: "user", content: "你好", createdAt: "t" },
  {
    id: "m2",
    sessionId: "s1",
    role: "assistant",
    content: "你好，有什么可以帮你？",
    createdAt: "t",
  },
  {
    id: "m3",
    sessionId: "s1",
    role: "error",
    content: "模型请求失败（HTTP 500）：x",
    createdAt: "t",
  },
];

describe("buildTaskStatus（/status 数据组装）", () => {
  it("返回模型、token 估算、消息数、AGENTS.md 来源与预留审批模式字段", () => {
    const discovery: AgentsMdDiscovery = {
      sections: [
        {
          source: "global",
          path: "C:\\Users\\u\\.codexlike\\AGENTS.md",
          content: "规范",
        },
      ],
      combined: "规范",
      truncated: false,
    };

    const status: TaskStatusInfo = buildTaskStatus({
      record: record(),
      messages,
      agentsMd: discovery,
      providerProfileName: "GLM",
      latestCompact: null,
    });

    expect(status.model).toBe("glm-4.7");
    expect(status.providerProfileName).toBe("GLM");
    // 估算 = 系统提示 + user + assistant（error 不计入）。
    // 手工按估算规则算：'规范' 2 CJK → 2；'你好' 2 CJK → 2；
    // '你好，有什么可以帮你？' 11 个 CJK/全角字符 → ceil(11/1.5) = 8。合计 12。
    expect(status.estimatedContextTokens).toBe(12);
    expect(status.messageCount).toBe(2);
    expect(status.agentsMd).toEqual({
      sources: ["C:\\Users\\u\\.codexlike\\AGENTS.md"],
      truncated: false,
    });
    // 审批模式：/status 显示会话真实档位
    expect(status.approvalMode).toBe("assist");
  });

  it("运行快照优先于磁盘规范，并将技能索引与已加载文本计入估算", () => {
    const resources = {
      catalog: {
        capturedAt: "2026-11-11T09:00:00Z",
        agents: {
          sources: [
            {
              path: "running/AGENTS.md",
              scope: "project" as const,
              bytes: 12,
              includedBytes: 12,
            },
          ],
          truncated: false,
        },
        skills: [],
        diagnostics: [],
        indexBytes: 16,
      },
      loaded: [],
      estimatedTokens: 50,
    };
    const status = buildTaskStatus({
      record: record(),
      messages,
      agentsMd: {
        sections: [
          { source: "global", path: "disk/AGENTS.md", content: "新版" },
        ],
        combined: "新版",
        truncated: false,
      },
      resources,
      resourcePhase: "active",
      lastResources: { ...resources, estimatedTokens: 900 },
      providerProfileName: null,
      latestCompact: null,
    });
    expect(status.estimatedContextTokens).toBe(60);
    expect(status.agentsMd?.sources).toEqual(["running/AGENTS.md"]);
    expect(status.resources).toEqual(resources);
    expect(status.resourcePhase).toBe("active");
    expect(status.lastResources?.estimatedTokens).toBe(900);
  });

  it("已提交问答计入上下文用量，但不增加用户消息轮次", () => {
    const input = {
      record: record(),
      messages,
      agentsMd: emptyDiscovery,
      providerProfileName: null,
      latestCompact: null,
    };
    const before = buildTaskStatus(input);
    const after = buildTaskStatus({
      ...input,
      messages: messages.map((message) =>
        message.role !== "user"
          ? message
          : {
              ...message,
              questionAnswers: [
                {
                  interactionId: "interaction-1",
                  source: { kind: "main" },
                  answers: [
                    {
                      questionId: "platform",
                      question: "你希望优先支持哪个桌面平台？",
                      status: "answered",
                      selectedOptions: ["Windows"],
                      text: "需要兼容中文输入法并保持键盘操作可用。",
                    },
                  ],
                },
              ],
            }
      ),
    });
    expect(after.estimatedContextTokens).toBeGreaterThan(
      before.estimatedContextTokens
    );
    expect(after.messageCount).toBe(2);
  });

  it("审批模式随会话记录透传（ask / full-access）", () => {
    for (const mode of ["ask", "full-access"] as const) {
      const status = buildTaskStatus({
        record: record({ approvalMode: mode }),
        messages: [],
        agentsMd: emptyDiscovery,
        providerProfileName: null,
        latestCompact: null,
      });
      expect(status.approvalMode).toBe(mode);
    }
  });

  it("无 AGENTS.md、未发过消息的最小会话", () => {
    const status = buildTaskStatus({
      record: record({ model: null, providerProfileId: null }),
      messages: [],
      agentsMd: emptyDiscovery,
      providerProfileName: null,
      latestCompact: null,
    });
    expect(status.model).toBeNull();
    expect(status.estimatedContextTokens).toBe(0);
    expect(status.messageCount).toBe(0);
    expect(status.agentsMd).toBeNull();
  });

  it("AGENTS.md 超限截断时 truncated 标记透传", () => {
    const discovery: AgentsMdDiscovery = {
      sections: [{ source: "global", path: "g", content: "c" }],
      combined: "c",
      truncated: true,
    };
    const status = buildTaskStatus({
      record: record(),
      messages: [],
      agentsMd: discovery,
      providerProfileName: null,
      latestCompact: null,
    });
    expect(status.agentsMd).toEqual({ sources: ["g"], truncated: true });
  });

  it("上下文窗口（告警阈值用，code review 修复 2）：Profile 配置透传，未配置为 null", () => {
    const configured = buildTaskStatus({
      record: record(),
      messages: [],
      agentsMd: emptyDiscovery,
      providerProfileName: null,
      contextWindowTokens: 200_000,
      latestCompact: null,
    });
    expect(configured.contextWindowTokens).toBe(200_000);

    const unconfigured = buildTaskStatus({
      record: record(),
      messages: [],
      agentsMd: emptyDiscovery,
      providerProfileName: null,
      latestCompact: null,
    });
    expect(unconfigured.contextWindowTokens).toBeNull();
  });
});

describe("buildTaskStatus 已压缩标记（工单 08）", () => {
  it("compact-summary 消息计入压缩后用量；latestCompact 透传摘要信息", () => {
    const compactedMessages: StoredMessage[] = [
      {
        id: "s1",
        sessionId: "s1",
        role: "compact-summary",
        content: "摘要内容",
        createdAt: "t",
      },
      {
        id: "m4",
        sessionId: "s1",
        role: "user",
        content: "继续",
        createdAt: "t",
      },
    ];
    const status = buildTaskStatus({
      record: record(),
      messages: compactedMessages,
      agentsMd: emptyDiscovery,
      providerProfileName: null,
      latestCompact: {
        id: "c1",
        sessionId: "s1",
        summary: "摘要内容",
        messagesCompacted: 8,
        createdAt: "2026-11-11T09:00:00.000Z",
      },
    });

    // 与实际上下文一致：摘要含 23 个 CJK 字符、38 个其它字符（标签及换行），
    // ceil(23 / 1.5 + 38 / 4) = 25；加上“继续”的 2 tokens，共 27。
    expect(status.estimatedContextTokens).toBe(27);
    expect(status.messageCount).toBe(2);
    expect(status.compacted).toEqual({
      at: "2026-11-11T09:00:00.000Z",
      messagesCompacted: 8,
    });
  });

  it("从未压缩的会话 compacted 为 null", () => {
    const status = buildTaskStatus({
      record: record(),
      messages,
      agentsMd: emptyDiscovery,
      providerProfileName: null,
      latestCompact: null,
    });
    expect(status.compacted).toBeNull();
  });
});
