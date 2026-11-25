import { describe, expect, it } from "vitest";

import type { ProviderProfile } from "@codexlike/agent-core";

import {
  busyCommandFeedback,
  formatTaskStatus,
  matchModelsForModelSwitch,
  planSlashCommand,
} from "../src/lib/slash-command-actions";
import type { TaskStatusInfo } from "@codexlike/desktop/ipc";

const profiles: ProviderProfile[] = [
  {
    id: "p1",
    name: "GLM",
    baseURL: "https://a",
    apiKey: "k",
    models: ["glm-4.7", "glm-4.6"],
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

/** /status 任务用量的零值（旧库/新建任务：四列缺失等价 0，ADR 0029） */
const ZERO_USAGE: TaskStatusInfo["usage"] = {
  inputTokens: 0,
  outputTokens: 0,
  subagentInputTokens: 0,
  subagentOutputTokens: 0,
};

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

  it("/goal 带目标文本 → set-goal；无参数 → 用法提示；没有任务时不可用（ADR 0035）", () => {
    expect(
      planSlashCommand({ name: "goal", argument: "让示例测试全部通过" }, true)
    ).toEqual({ type: "set-goal", text: "让示例测试全部通过" });
    expect(planSlashCommand({ name: "goal", argument: "" }, true)).toEqual({
      type: "goal-missing-argument",
    });
    expect(
      planSlashCommand({ name: "goal", argument: "让示例测试全部通过" }, false)
    ).toEqual({ type: "needs-task" });
  });
});

describe("matchModelsForModelSwitch（/model 关键词匹配，票 02 模型级平铺）", () => {
  it("唯一命中：按「Profile 名 模型名」模糊匹配到具体模型（含中文名）", () => {
    expect(matchModelsForModelSwitch("deep", profiles)).toEqual({
      kind: "unique",
      profile: profiles[1],
      model: "deepseek-v4",
    });
  });

  it("同 Profile 的两个模型可用模型名区分：命中其一即唯一", () => {
    expect(matchModelsForModelSwitch("glm-4.6", profiles)).toEqual({
      kind: "unique",
      profile: profiles[0],
      model: "glm-4.6",
    });
  });

  it("多命中：列出平铺候选（Profile · 模型）交由用户再用一次 /model 精确指定", () => {
    const result = matchModelsForModelSwitch("glm", profiles);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(
        result.candidates.map(
          (candidate) => `${candidate.profile.name} · ${candidate.model}`
        )
      ).toEqual([
        "GLM · glm-4.7",
        "GLM · glm-4.6",
        "GLM 便宜档 · glm-4.7-flash",
      ]);
    }
  });

  it("空关键词与零命中：返回全部平铺候选（无匹配时也列出可选项）", () => {
    expect(matchModelsForModelSwitch("", profiles).kind).toBe("ambiguous");
    const none = matchModelsForModelSwitch("不存在的模型", profiles);
    expect(none.kind).toBe("ambiguous");
    if (none.kind === "ambiguous") {
      expect(none.candidates).toHaveLength(4);
    }
  });
});

/** /status 最小合法载荷（TaskStatusInfo 加字段只改这里，用例按需 override） */
function statusInfo(overrides: Partial<TaskStatusInfo> = {}): TaskStatusInfo {
  return {
    model: null,
    providerProfileName: null,
    estimatedContextTokens: 0,
    contextWindowTokens: null,
    messageCount: 0,
    usage: ZERO_USAGE,
    agentsMd: null,
    approvalMode: "assist",
    compacted: null,
    ...overrides,
  };
}

describe("formatTaskStatus（/status 展示文案）", () => {
  it("任务用量行（ADR 0029）：总量与子代理份额分列显示，全 0 也照常显示", () => {
    const text = formatTaskStatus(
      statusInfo({
        model: "glm-4.7",
        providerProfileName: "GLM",
        estimatedContextTokens: 500,
        messageCount: 3,
        usage: {
          inputTokens: 700,
          outputTokens: 120,
          subagentInputTokens: 500,
          subagentOutputTokens: 90,
        },
      })
    );
    expect(text).toContain(
      "任务用量：输入 700 / 输出 120 tokens（其中子代理 输入 500 / 输出 90）"
    );

    // 不回补、不隐藏：全 0 的任务照常显示（自统计起算）
    expect(formatTaskStatus(statusInfo())).toContain(
      "任务用量：输入 0 / 输出 0 tokens（其中子代理 输入 0 / 输出 0）"
    );
  });

  it("最近轮摘要独立显示采集时间与分执行者加载，明确不代表当前激活", () => {
    for (const resourcePhase of ["active", "preview"] as const) {
      const text = formatTaskStatus(
        statusInfo({
          estimatedContextTokens: 500,
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
        })
      );
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
    const status = statusInfo();
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
      const text = formatTaskStatus(
        statusInfo({
          estimatedContextTokens: 500,
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
        })
      );
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
    const text = formatTaskStatus(
      statusInfo({
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
      })
    );
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
      expect(formatTaskStatus(statusInfo({ approvalMode: mode }))).toContain(
        expected
      );
    }
  });

  it("未发现 AGENTS.md、未选模型时的降级文案", () => {
    const text = formatTaskStatus(statusInfo());
    expect(text).toContain("未选择");
    expect(text).toContain("未发现");
  });
});

/** 票 04 追加 B：忙时斜杠命令的本地命令反馈——目标进行中的口径 */
describe("busyCommandFeedback（忙时斜杠命令的本地命令反馈）", () => {
  it("普通任务执行中：既有文案不变——命令不入队，回复结束后可用", () => {
    expect(busyCommandFeedback("status", { goalRunning: false })).toBe(
      "命令 /status 不入队：回复结束后可用（输入已保留）"
    );
  });

  it("目标进行中执行 /compact：专门提示先暂停目标（完成判定依赖完整历史），不执行压缩", () => {
    const text = busyCommandFeedback("compact", { goalRunning: true });
    expect(text).toBe(
      "目标进行中不能压缩历史：请先暂停目标（完成判定依赖完整历史）（输入已保留）"
    );
  });

  it("目标进行中执行其他命令：仍是不入队（不开后门），可用时机说准为目标暂停或结束后", () => {
    for (const name of [
      "rename",
      "model",
      "status",
      "new",
      "archive",
      "goal",
    ] as const) {
      expect(busyCommandFeedback(name, { goalRunning: true })).toBe(
        `命令 /${name} 不入队：目标暂停或结束后可用（输入已保留）`
      );
    }
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
    const text = formatTaskStatus(
      statusInfo({
        model: "glm-4.7",
        providerProfileName: "GLM",
        estimatedContextTokens: 210,
        messageCount: 7,
        compacted: { at: "2026-11-11T09:00:00.000Z", messagesCompacted: 8 },
      })
    );
    expect(text).toContain("已压缩");
    expect(text).toContain("8");
    expect(text).toContain("210");
  });

  it("formatTaskStatus：未压缩时不显示压缩标记", () => {
    expect(formatTaskStatus(statusInfo())).not.toContain("已压缩");
  });
});
