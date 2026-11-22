import type { MessageSegment, ToolCallSegment } from "./task-view";

/**
 * terminal_read 轮内锚点（ADR 0033「消息流 read 锚点」）的终端域判定：
 * 工具名、会话标识解析与空读识别，供 turn-view 聚合与锚点行组件共用。
 */

/** terminal_read 工具名（聚合与渲染分派的单一来源） */
export const TERMINAL_READ_TOOL = "terminal_read";

/**
 * 终端会话名索引（read 锚点呈现）：sessionId → record.name，主消息流与
 * 右栏子代理详情流各自从段序列派生（同一份规则，workspace 侧另建实例——
 * 两处数据源不同：主流 items 自含终端段，rail 子代理 tab 走页面级派生）。
 */
export function terminalNameIndex(
  segments: MessageSegment[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of segments) {
    if (item.kind === "terminal") map.set(item.sessionId, item.name);
  }
  return map;
}

/**
 * 从 read 调用参数解析目标会话 id；非 read 调用或参数畸形（缺 sessionId /
 * JSON 不合法）返回 undefined——调用方退回原工具卡呈现，不丢段。
 */
export function terminalReadSessionId(
  call: ToolCallSegment
): string | undefined {
  if (call.toolName !== TERMINAL_READ_TOOL) return undefined;
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const sessionId = (parsed as Record<string, unknown>)["sessionId"];
      if (typeof sessionId === "string" && sessionId !== "") return sessionId;
    }
  } catch {
    // 畸形 JSON：退回原卡呈现（呈现不丢段优先）
  }
  return undefined;
}

/** 空读输出标记前缀（core 侧 formatReadOutput 空增量的固定文案开头） */
const NO_OUTPUT_MARKER = "[暂无新输出";

/**
 * 空读判定（ADR 0033 read 锚点）：已完成且输出为「暂无新输出」标记文案。
 * 空读计入锚点计数、展开态极简行呈现，不静默。运行中段（output 尚空）与
 * 有输出的读不算空读。
 */
export function isNoOutputRead(call: ToolCallSegment): boolean {
  if (call.toolName !== TERMINAL_READ_TOOL) return false;
  if (call.running === true) return false;
  return call.output.startsWith(NO_OUTPUT_MARKER);
}
