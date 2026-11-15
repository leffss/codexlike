import {
  DEFAULT_MAX_TOOL_ROUNDS,
  TOOL_ROUNDS_MAX,
  TOOL_ROUNDS_MIN,
} from "@codexlike/agent-core";

/**
 * 执行设置表单解析（ADR 0017，GLOSSARY「工具轮次」）：
 * 输入框文本 → 工具轮次上限（主任务与子代理项共用同一合法范围 10–1000，
 * 解析规则同构）。范围内的整数原样生效；非法/越界输入（空串、非整数、
 * 10–1000 之外）回退 fallback 默认值，回退值随保存写回输入框（用户可见
 * 回退结果）。默认值可指定：主任务项用 DEFAULT_MAX_TOOL_ROUNDS、子代理项用
 * DEFAULT_MAX_SUBAGENT_TOOL_ROUNDS（各自常量来源，防语义耦合后数字分叉）；
 * 范围常量取自 agent-core（与存储校验同一来源）。
 */
export function parseToolRoundsInput(
  text: string,
  fallback: number = DEFAULT_MAX_TOOL_ROUNDS
): number {
  const num = Number(text);
  if (
    !Number.isInteger(num) ||
    num < TOOL_ROUNDS_MIN ||
    num > TOOL_ROUNDS_MAX
  ) {
    return fallback;
  }
  return num;
}
