import { describe, expect, it } from "vitest";

import type { ProviderProfile } from "@codexlike/agent-core";

import {
  formatTaskStatus,
  matchProfilesForModelSwitch,
  planSlashCommand,
} from "../src/lib/slash-command-actions";
import type { TaskStatusInfo } from "@codexlike/desktop/ipc";

const profiles: ProviderProfile[] = [
  {
    id: "p1",
    name: "GLM",
    baseURL: "https://a",
    apiKey: "k",
    models: ["glm-4.7"],
  },
  {
    id: "p2",
    name: "DeepSeek",
    baseURL: "https://b",
    apiKey: "k",
    models: ["deepseek-v4"],
  },
  {
    id: "p3",
    name: "GLM 便宜档",
    baseURL: "https://c",
    apiKey: "k",
    models: ["glm-4.7-flash"],
  },
];

/** 斜杠命令 → UI 动作的纯函数分发（命令与等效 UI 操作走同一 IPC 通道，ui 只做编排） */
describe("planSlashCommand", () => {
  it("/new：按管理归属打开新草稿，不依赖执行工作区", () => {
    expect(planSlashCommand({ name: "new", argument: "" }, true)).toEqual({
      type: "new-task",
    });
  });

  it("/rename 带参数 → rename；无参数 → 用法提示", () => {
    expect(
      planSlashCommand({ name: "rename", argument: "修 bug" }, true)
    ).toEqual({
      type: "rename",
      title: "修 bug",
    });
    expect(planSlashCommand({ name: "rename", argument: "" }, true)).toEqual({
      type: "rename-missing-argument",
    });
  });

  it("/archive → archive；/status → status", () => {
    expect(planSlashCommand({ name: "archive", argument: "" }, true)).toEqual({
      type: "archive",
    });
    expect(planSlashCommand({ name: "status", argument: "" }, true)).toEqual({
      type: "status",
    });
  });

  it("除 /new 外的命令在没有任务时不可用", () => {
    expect(planSlashCommand({ name: "status", argument: "" }, false)).toEqual({
      type: "needs-task",
    });
    expect(planSlashCommand({ name: "rename", argument: "x" }, false)).toEqual({
      type: "needs-task",
    });
  });

  it("新草稿中的 /new 与新建按钮一样可用，不要求先产生空任务", () => {
    expect(planSlashCommand({ name: "new", argument: "" }, false)).toEqual({
      type: "new-task",
    });
  });
});

describe("matchProfilesForModelSwitch（/model 关键词匹配）", () => {
  it("唯一命中：按名称模糊匹配（含中文名）", () => {
    expect(matchProfilesForModelSwitch("deep", profiles)).toEqual({
      kind: "unique",
      profile: profiles[1],
    });
  });

  it("多命中：列出候选交由用户再用一次 /model 精确指定", () => {
    const result = matchProfilesForModelSwitch("glm", profiles);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((p) => p.name)).toEqual([
        "GLM",
        "GLM 便宜档",
      ]);
    }
  });

  it("空关键词与零命中：返回全部候选（无匹配时也列出可选项）", () => {
    expect(matchProfilesForModelSwitch("", profiles).kind).toBe("ambiguous");
    const none = matchProfilesForModelSwitch("不存在的模型", profiles);
    expect(none.kind).toBe("ambiguous");
    if (none.kind === "ambiguous") {
      expect(none.candidates).toHaveLength(3);
    }
  });
});

describe("formatTaskStatus（/status 展示文案）", () => {
  it("最近轮摘要独立显示采集时间与分执行者加载，明确不代表当前激活", () => {
    for (const resourcePhase of ["active", "preview"] as const) {
      const text = formatTaskStatus({
        model: null,
        providerProfileName: null,
        estimatedContextTokens: 500,
        messageCount: 0,
        agentsMd: null,
        approvalMode: "assist",
        contextWindowTokens: null,
        compacted: null,
        resourcePhase,
        resources: {
          estimatedTokens: 10,
          loaded: [],
          catalog: {
            capturedAt: "2026-11-11T02:00:00Z",
            indexBytes: 0,
            agents: { sources: [], truncated: false },
            skills: [],
            diagnostics: [],
          },
        },
        lastResources: {
          estimatedTokens: 100,
          catalog: {
            capturedAt: "2026-11-11T01:00:00Z",
            indexBytes: 0,
            agents: { sources: [], truncated: false },
            skills: [],
            diagnostics: [],
          },
          loaded: [
            {
              executorId: "main",
              name: "previous-review",
              path: "/previous/SKILL.md",
              kind: "skill",
              bytes: 50,
            },
            {
              executorId: "child-previous",
              name: "previous-review",
              path: "/previous/example.txt",
              kind: "resource",
              bytes: 20,
            },
          ],
        },
      });
      expect(text).toContain(
        resourcePhase === "active"
          ? "当前运行快照（active）"
          : "下轮磁盘预览（preview，非当前已加载）"
      );
      expect(text).toContain("最近一轮摘要（last，非当前激活）");
      expect(text).toContain("采集于 2026-11-11T01:00:00Z");
      expect(text).toContain(
        "执行者 main：$previous-review skill /previous/SKILL.md（50 字节）"
      );
      expect(text).toContain(
        "执行者 child-previous：$previous-review resource /previous/example.txt（20 字节）"
      );
      expect(text).toContain("已加载：无（技能正文仅本轮生效）");
    }
  });
  it("没有最近轮摘要不显示历史加载，空加载摘要仍展示采集时间", () => {
    const status: TaskStatusInfo = {
      model: null,
      providerProfileName: null,
      estimatedContextTokens: 0,
      messageCount: 0,
      agentsMd: null,
      approvalMode: "assist",
      contextWindowTokens: null,
      compacted: null,
    };
    expect(formatTaskStatus(status)).not.toContain("最近一轮摘要");
    expect(formatTaskStatus({ ...status, lastResources: null })).not.toContain(
      "最近一轮摘要"
    );
    const text = formatTaskStatus({
      ...status,
      lastResources: {
        estimatedTokens: 0,
        loaded: [],
        catalog: {
          capturedAt: "2026-11-11T03:00:00Z",
          indexBytes: 0,
          agents: { sources: [], truncated: false },
          skills: [],
          diagnostics: [],
        },
      },
    });
    expect(text).toContain("采集于 2026-11-11T03:00:00Z");
    expect(text).toContain("最近一轮已加载：无");
    expect(text).not.toContain("当前运行快照");
  });

  it("资源状态区分当前快照和下轮预览，展示来源/状态/诊断与执行者而非正文", () => {
    for (const resourcePhase of ["active", "preview"] as const) {
      const text = formatTaskStatus({
        model: null,
        providerProfileName: null,
        estimatedContextTokens: 500,
        messageCount: 0,
        agentsMd: null,
        approvalMode: "assist",
        contextWindowTokens: null,
        compacted: null,
        resourcePhase,
        resources: {
          estimatedTokens: 200,
          loaded: [
            {
              executorId: "child-2",
              name: "review",
              path: "/review/SKILL.md",
              kind: "skill",
              bytes: 50,
            },
          ],
          catalog: {
            capturedAt: "2026-11-11T01:00:00Z",
            indexBytes: 80,
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
                path: "/review/SKILL.md",
                directory: "/review",
                scope: "project",
                source: "agents",
                status: "shadowed",
                reason: "已覆盖来源",
              },
            ],
            diagnostics: [{ path: "/review/SKILL.md", message: "诊断信息" }],
          },
        },
      });
      for (const expected of [
        resourcePhase === "active" ? "当前运行快照" : "下轮磁盘预览",
        "/project/AGENTS.md",
        "32768",
        "40000",
        "已截断",
        "child-2",
        "review",
        "已覆盖来源",
        "诊断信息",
        "200",
      ])
        expect(text).toContain(expected);
    }
  });
  it("包含模型、用量估算、消息数、AGENTS.md 来源与审批模式（中文档位说明）", () => {
    const text = formatTaskStatus({
      model: "glm-4.7",
      providerProfileName: "GLM",
      estimatedContextTokens: 1234,
      messageCount: 12,
      agentsMd: {
        sources: [
          "C:\\Users\\u\\.codexlike\\AGENTS.md",
          "C:\\work\\demo\\AGENTS.md",
        ],
        truncated: false,
      },
      approvalMode: "assist",
      contextWindowTokens: null,
      compacted: null,
    } satisfies TaskStatusInfo);
    expect(text).toContain("模型：GLM · glm-4.7");
    expect(text).toContain("1234");
    expect(text).toContain("12");
    expect(text).toContain("AGENTS.md");
    expect(text).toContain("2 个来源");
    expect(text).toContain(
      "审批模式：帮我批准（assist）：文件编辑与联网自动放行，仅危险命令询问"
    );
  });

  it("ask / full-access 档位的中文说明", () => {
    for (const [mode, expected] of [
      ["ask", "请求批准（ask）：编辑文件、执行命令与联网搜索前先询问"],
      [
        "full-access",
        "完全访问（full-access）：全自动执行，且不受限读写本地任意文件",
      ],
    ] as const) {
      const text = formatTaskStatus({
        model: null,
        providerProfileName: null,
        estimatedContextTokens: 0,
        messageCount: 0,
        agentsMd: null,
        approvalMode: mode,
        contextWindowTokens: null,
        compacted: null,
      } satisfies TaskStatusInfo);
      expect(text).toContain(expected);
    }
  });

  it("未发现 AGENTS.md、未选模型时的降级文案", () => {
    const text = formatTaskStatus({
      model: null,
      providerProfileName: null,
      estimatedContextTokens: 0,
      messageCount: 0,
      agentsMd: null,
      approvalMode: "assist",
      contextWindowTokens: null,
      compacted: null,
    } satisfies TaskStatusInfo);
    expect(text).toContain("未选择");
    expect(text).toContain("未发现");
  });
});

/** 工单 08：/compact 命令分发与 /status 已压缩文案 */
describe("/compact（手动压缩）ui 分发", () => {
  it("/compact → compact 动作；无任务时 needs-task", () => {
    expect(planSlashCommand({ name: "compact", argument: "" }, true)).toEqual({
      type: "compact",
    });
    expect(planSlashCommand({ name: "compact", argument: "" }, false)).toEqual({
      type: "needs-task",
    });
  });

  it("formatTaskStatus：已压缩时显示「已压缩」标记与压缩后用量", () => {
    const text = formatTaskStatus({
      model: "glm-4.7",
      providerProfileName: "GLM",
      estimatedContextTokens: 210,
      messageCount: 7,
      agentsMd: null,
      approvalMode: "assist",
      contextWindowTokens: null,
      compacted: { at: "2026-11-11T09:00:00.000Z", messagesCompacted: 8 },
    } satisfies TaskStatusInfo);
    expect(text).toContain("已压缩");
    expect(text).toContain("8");
    expect(text).toContain("210");
  });

  it("formatTaskStatus：未压缩时不显示压缩标记", () => {
    const text = formatTaskStatus({
      model: null,
      providerProfileName: null,
      estimatedContextTokens: 0,
      messageCount: 0,
      agentsMd: null,
      approvalMode: "assist",
      contextWindowTokens: null,
      compacted: null,
    } satisfies TaskStatusInfo);
    expect(text).not.toContain("已压缩");
  });
});
