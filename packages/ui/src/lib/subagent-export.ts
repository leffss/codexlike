import type { SubagentSegment } from "./task-view";
import { statusText, terminalTimeLabel } from "./subagent-status";
import {
  STEP_STATUS_LABELS,
  collectSubagentPlanSnapshots,
  planSummaryLine,
} from "./plan-view";

/**
 * 工作计划终态段（票 03，ADR 0023）：终态快照复用票 02 收集薄壳从
 * subagent.tools 派生（最后一次 update_plan 的完整清单，全量替换语义），
 * 统计行与 agent-core 工具执行输出同口径（三态计数与格式串收口
 * plan-view 单一来源）；中断回看最后快照与计划卡语义一致（无 report
 * 时段照出）。无计划（无 update_plan 或解析为空）返回空数组——段整体
 * 省略。
 */
function planSectionLines(subagent: SubagentSegment): string[] {
  const steps =
    collectSubagentPlanSnapshots(subagent.tools).at(-1)?.steps ?? [];
  if (steps.length === 0) return [];
  return [
    "",
    "## 工作计划",
    "",
    planSummaryLine(steps),
    "",
    ...steps.map(
      (step) => `- ${STEP_STATUS_LABELS[step.status]}：${step.content}`
    ),
  ];
}

/**
 * 子代理导出 Markdown（ADR 0021 票 04）：逐轮正文与思考的结构化全文，
 * 供离线归档与分享（files.saveText 原生保存对话框）。
 *
 * 结构：委派说明头（task 原文）+ 状态与起止时间 + 逐轮记录（每轮思考/
 * 正文小节，轮边界即 subagent_messages 行边界）+ 工作计划终态段（票 03，
 * 最终报告之前，无计划省略）+ 最终报告（完成/失败照录，interrupted 无此
 * 段）。旧记录（无逐轮数据，本特性落地前的汇总行）回退纯报告导出——
 * 源头无轮边界可拆（彼时子代理无 update_plan，自然无计划段）。
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
  lines.push(...planSectionLines(subagent));
  if (subagent.report !== null) {
    lines.push("", "## 最终报告", "", subagent.report);
  }
  return lines.join("\n");
}
