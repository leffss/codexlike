import {
  fuzzyMatch,
  type ProviderProfile,
  type SlashCommandName,
} from "@codexlike/agent-core";

import type { SessionStatusInfo } from "@codexlike/desktop/ipc";

/**
 * 斜杠命令 → UI 动作的纯函数分发。
 * 命令与等效 UI 操作最终走同一 IPC 通道（/rename ↔ 侧栏重命名、/archive ↔ 侧栏归档、
 * /model ↔ 模型选择器、/new ↔ 新建会话、/status ↔ status 查询），这里只做编排决策。
 */

export type SlashCommandAction =
  | { type: "new-session" }
  | { type: "compact" }
  | { type: "rename"; title: string }
  | { type: "rename-missing-argument" }
  | { type: "archive" }
  | { type: "select-model"; query: string }
  | { type: "status" }
  | { type: "needs-session" };

/** 所有命令都作用于「当前会话」（/new 也需要当前会话的工作区） */
export function planSlashCommand(
  command: { name: SlashCommandName; argument: string },
  hasSession: boolean
): SlashCommandAction {
  if (!hasSession) {
    return { type: "needs-session" };
  }
  switch (command.name) {
    case "new":
      return { type: "new-session" };
    case "compact":
      return { type: "compact" };
    case "rename":
      return command.argument === ""
        ? { type: "rename-missing-argument" }
        : { type: "rename", title: command.argument };
    case "archive":
      return { type: "archive" };
    case "model":
      return { type: "select-model", query: command.argument };
    case "status":
      return { type: "status" };
  }
}

/** /model 关键词匹配：在 name + model 文本上模糊匹配 */
export type ModelSwitchMatch =
  | { kind: "unique"; profile: ProviderProfile }
  | { kind: "ambiguous"; candidates: ProviderProfile[] };

export function matchProfilesForModelSwitch(
  query: string,
  profiles: readonly ProviderProfile[]
): ModelSwitchMatch {
  const matched = fuzzyMatch(
    query,
    profiles,
    (profile) => `${profile.name} ${profile.model}`
  );
  if (matched.length === 1) {
    return { kind: "unique", profile: matched[0]! };
  }
  // 多个命中：列出命中的候选；零命中（拼写误差）：列出全部供用户选择
  return {
    kind: "ambiguous",
    candidates: matched.length === 0 ? [...profiles] : matched,
  };
}

/** 审批模式 → /status 中文文案（GLOSSARY「审批模式」：请求批准 / 帮我批准 / 完全访问） */
const APPROVAL_MODE_LABELS: Record<SessionStatusInfo["approvalMode"], string> =
  {
    ask: "请求批准（ask）：编辑文件、执行命令与联网搜索前先询问",
    assist: "帮我批准（assist）：文件编辑与联网自动放行，仅危险命令询问",
    "full-access":
      "完全访问（full-access）：全自动执行，且不受限读写本地任意文件",
  };

/** /status 展示文案（中文） */
export function formatSessionStatus(status: SessionStatusInfo): string {
  const model =
    status.model === null
      ? "未选择（发送消息后记录所用模型）"
      : `${status.providerProfileName ?? "未知 Profile"} · ${status.model}`;
  const agents = status.resources?.catalog.agents ?? status.agentsMd;
  const agentsMd =
    agents === null
      ? "未发现 AGENTS.md"
      : `${agents.sources.length} 个来源${
          agents.truncated ? "（总量超 32 KiB 已截断）" : ""
        }`;
  const compacted =
    status.compacted === null
      ? "未压缩"
      : `已压缩（${status.compacted.at.replace("T", " ").slice(0, 19)}，压缩了 ${status.compacted.messagesCompacted} 条历史消息）`;
  return [
    "会话状态（/status）",
    `模型：${model}`,
    `上下文用量（估算）：约 ${status.estimatedContextTokens} tokens（${status.messageCount} 条消息 + 系统提示）`,
    `压缩状态：${compacted}`,
    `AGENTS.md：${agentsMd}`,
    `审批模式：${APPROVAL_MODE_LABELS[status.approvalMode]}`,
    ...(status.resources === undefined
      ? []
      : [
          `资源：${status.resourcePhase === "active" ? "当前运行快照（active）" : "下轮磁盘预览（preview，非当前已加载）"}`,
          `资源估算：约 ${status.resources.estimatedTokens} tokens；索引 ${status.resources.catalog.indexBytes} 字节`,
          ...status.resources.catalog.agents.sources.map(
            (source) =>
              `- AGENTS ${source.path}：已纳入 ${source.includedBytes} / ${source.bytes} 字节`
          ),
          ...status.resources.catalog.skills.map(
            (skill) =>
              `- $${skill.name} [${skill.status}] ${skill.scope}/${skill.source} ${skill.path}${skill.reason ? `：${skill.reason}` : ""}`
          ),
          status.resources.loaded.length === 0
            ? "已加载：无（技能正文仅本轮生效）"
            : "已加载（按执行者独立记录）：",
          ...status.resources.loaded.map(
            (record) =>
              `- 执行者 ${record.executorId}：$${record.name} ${record.kind} ${record.path}（${record.bytes} 字节）`
          ),
          ...status.resources.catalog.diagnostics.map(
            (diagnostic) => `- 诊断 ${diagnostic.path}：${diagnostic.message}`
          ),
          "完整来源元数据请查看「规范与技能」；不展示正文。",
        ]),
    ...(status.lastResources == null
      ? []
      : [
          "最近一轮摘要（last，非当前激活）",
          `采集于 ${status.lastResources.catalog.capturedAt}`,
          "以下仅为最近一轮加载记录，不会自动激活本轮技能。",
          status.lastResources.loaded.length === 0
            ? "最近一轮已加载：无"
            : "最近一轮已加载（按执行者独立记录）：",
          ...status.lastResources.loaded.map(
            (record) =>
              `- 执行者 ${record.executorId}：$${record.name} ${record.kind} ${record.path}（${record.bytes} 字节）`
          ),
        ]),
  ].join("\n");
}
