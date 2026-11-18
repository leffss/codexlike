import type { ApprovalMode, ThinkingEffort } from "@codexlike/agent-core";

/**
 * composer 系选择器的选项表（新建任务居中起点式票 01 抽共享）：
 * 从 MessageComposer 原样移出——正式任务 composer 工具栏与新建起点页
 * 决策行共用同一组选项文案与 title 提示，只做代码移动，不改任何条目。
 */

/** 审批模式 → 选择器文案（GLOSSARY「审批模式」三档：请求批准 / 帮我批准 / 完全访问） */
export const APPROVAL_MODE_OPTIONS: {
  value: ApprovalMode;
  label: string;
  title: string;
}[] = [
  {
    value: "ask",
    label: "请求批准",
    title: "ask：编辑文件、执行命令与联网搜索前先询问我",
  },
  {
    value: "assist",
    label: "帮我批准",
    title: "assist：文件编辑与联网自动放行，仅危险命令（rm、强推等）询问我",
  },
  {
    value: "full-access",
    label: "完全访问",
    title: "full-access：全自动执行，且可不受限读写本地任意文件（切换需确认）",
  },
];

/**
 * 思考档位（GLOSSARY「思考档位」）→ 弹层内档位文案。
 * 任务独立记忆、重启后保留；调整只对下一次发送生效，不改变已开始的
 * 执行或历史。「关」是显式发送关闭请求，不保证强制思考模型实际停止
 * 思考（以服务端行为为准）。
 */
export const THINKING_EFFORT_OPTIONS: {
  value: ThinkingEffort;
  label: string;
  title: string;
}[] = [
  {
    value: "auto",
    label: "思考：自动",
    title: "自动：不附加控制参数，由服务端决定思考行为（默认）",
  },
  {
    value: "low",
    label: "思考：低",
    title: "低：请求较浅的思考强度（下一条消息生效）",
  },
  {
    value: "medium",
    label: "思考：中",
    title: "中：请求中等思考强度（下一条消息生效）",
  },
  {
    value: "high",
    label: "思考：高",
    title: "高：请求更深思考强度（下一条消息生效）",
  },
  {
    value: "off",
    label: "思考：关",
    title: "关：显式请求关闭思考；服务端可能忽略，不保证强制停止",
  },
];
