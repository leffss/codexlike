import type { SubagentSegment } from "./task-view";
import { statusText, terminalTimeLabel } from "./subagent-status";

/**
 * 子代理导出 Markdown（ADR 0021 票 04）：逐轮正文与思考的结构化全文，
 * 供离线归档与分享（files.saveText 原生保存对话框）。
 *
 * 结构：委派说明头（task 原文）+ 状态与起止时间 + 逐轮记录（每轮思考/
 * 正文小节，轮边界即 subagent_messages 行边界）+ 最终报告（完成/失败照录，
 * interrupted 无此段）。旧记录（无逐轮数据，本特性落地前的汇总行）回退
 * 纯报告导出——源头无轮边界可拆。
 */
export function subagentExportMarkdown(subagent: SubagentSegment): string {
  const title = subagent.task === "" ? "（任务描述缺失）" : subagent.task;
  const lines: string[] = [
    `# 子代理：${title}`,
    "",
    `状态：${statusText(subagent)}`,
  ];
  if (subagent.startedAt !== null) {
    lines.push(`开始：${subagent.startedAt}`);
  }
  if (subagent.endedAt !== null) {
    // 终态时刻行标签（完成/中断）取自 lib/subagent-status 单一来源
    lines.push(`${terminalTimeLabel(subagent)}：${subagent.endedAt}`);
  }
  // 逐轮记录：空轮（工具占位）跳过；无思考/正文的轮省略对应小节
  const rounds = (subagent.turns ?? []).filter(
    (turn) => turn.content !== "" || (turn.reasoning ?? "") !== ""
  );
  if (rounds.length > 0) {
    lines.push("", "## 逐轮记录");
    rounds.forEach((turn, index) => {
      lines.push("", `### 第 ${index + 1} 轮`);
      if ((turn.reasoning ?? "") !== "") {
        lines.push("", "#### 思考", "", turn.reasoning!);
      }
      if (turn.content !== "") {
        lines.push("", "#### 正文", "", turn.content);
      }
    });
  }
  if (subagent.report !== null) {
    lines.push("", "## 最终报告", "", subagent.report);
  }
  return lines.join("\n");
}
