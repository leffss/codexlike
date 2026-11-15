import {
  DEFAULT_MAX_TOOL_ROUNDS,
  TOOL_ROUNDS_MAX,
  TOOL_ROUNDS_MIN,
} from "@codexlike/agent-core";

/**
 * 执行设置表单解析（ADR 0017，GLOSSARY「工具轮次」）：
 * 输入框文本 → 主任务工具轮次上限。范围内的整数原样生效；
 * 非法/越界输入（空串、非整数、10–1000 之外）回退默认 200，
 * 回退值随保存写回输入框（用户可见回退结果）。
 * 默认值与范围常量取自 agent-core（与存储校验同一来源）。
 */
export function parseToolRoundsInput(text: string): number {
  const num = Number(text);
  if (
    !Number.isInteger(num) ||
    num < TOOL_ROUNDS_MIN ||
    num > TOOL_ROUNDS_MAX
  ) {
    return DEFAULT_MAX_TOOL_ROUNDS;
  }
  return num;
}
