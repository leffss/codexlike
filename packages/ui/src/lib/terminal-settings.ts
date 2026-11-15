import {
  COMMAND_TIMEOUT_SECONDS_MAX,
  COMMAND_TIMEOUT_SECONDS_MIN,
  MAX_COMMAND_TIMEOUT_SECONDS_MAX,
  MAX_COMMAND_TIMEOUT_SECONDS_MIN,
} from "@codexlike/agent-core";

/**
 * 终端设置分区的输入校验（执行设置票04，组织先例同 mcp-form.ts：
 * 设置页纯逻辑独立成 lib 供组件与测试共用）。
 */

/**
 * 终端超时联动校验（纯函数）：命令超时 5-600s、最大命令超时 10-1800s
 * 且命令超时 ≤ 最大命令超时（范围常量取自 agent-core execution-settings
 * 单一来源，与主进程存储校验同源防数字分叉，code review 修复 3）；
 * 非法返回中文错误消息，合法返回 null。
 * 保存前在 UI 层拦截，主进程 IPC 边界与存储层各自再校验（纵深防御）。
 */
export function validateTerminalTimeouts(
  commandText: string,
  maxText: string
): string | null {
  const command = Number(commandText);
  if (
    commandText.trim() === "" ||
    !Number.isInteger(command) ||
    command < COMMAND_TIMEOUT_SECONDS_MIN ||
    command > COMMAND_TIMEOUT_SECONDS_MAX
  ) {
    return `命令超时必须是 ${COMMAND_TIMEOUT_SECONDS_MIN}-${COMMAND_TIMEOUT_SECONDS_MAX} 的整数（秒）`;
  }
  const max = Number(maxText);
  if (
    maxText.trim() === "" ||
    !Number.isInteger(max) ||
    max < MAX_COMMAND_TIMEOUT_SECONDS_MIN ||
    max > MAX_COMMAND_TIMEOUT_SECONDS_MAX
  ) {
    return `最大命令超时必须是 ${MAX_COMMAND_TIMEOUT_SECONDS_MIN}-${MAX_COMMAND_TIMEOUT_SECONDS_MAX} 的整数（秒）`;
  }
  if (command > max) {
    return "命令超时不能大于最大命令超时";
  }
  return null;
}
