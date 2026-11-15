/**
 * 终端设置分区的输入校验（执行设置票04，组织先例同 mcp-form.ts：
 * 设置页纯逻辑独立成 lib 供组件与测试共用）。
 */

/**
 * 终端超时联动校验（纯函数）：命令超时 5-600s、最大命令超时 10-1800s
 * 且命令超时 ≤ 最大命令超时；非法返回中文错误消息，合法返回 null。
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
    command < 5 ||
    command > 600
  ) {
    return "命令超时必须是 5-600 的整数（秒）";
  }
  const max = Number(maxText);
  if (
    maxText.trim() === "" ||
    !Number.isInteger(max) ||
    max < 10 ||
    max > 1800
  ) {
    return "最大命令超时必须是 10-1800 的整数（秒）";
  }
  if (command > max) {
    return "命令超时不能大于最大命令超时";
  }
  return null;
}
