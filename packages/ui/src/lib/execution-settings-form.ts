import {
  COMPACT_KEEP_ROUNDS_MAX,
  COMPACT_KEEP_ROUNDS_MIN,
  CONTEXT_WARNING_PERCENT_MAX,
  CONTEXT_WARNING_PERCENT_MIN,
  DEFAULT_COMPACT_KEEP_ROUNDS,
  DEFAULT_CONTEXT_WARNING_PERCENT,
  DEFAULT_MAX_TOOL_ROUNDS,
  DEFAULT_MCP_CALL_TIMEOUT_SECONDS,
  DEFAULT_MCP_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_MODEL_MAX_RETRIES,
  DEFAULT_TASK_CONCURRENCY_LIMIT,
  MCP_CALL_TIMEOUT_SECONDS_MAX,
  MCP_CALL_TIMEOUT_SECONDS_MIN,
  MCP_CONNECT_TIMEOUT_SECONDS_MAX,
  MCP_CONNECT_TIMEOUT_SECONDS_MIN,
  MODEL_MAX_RETRIES_MAX,
  MODEL_MAX_RETRIES_MIN,
  TASK_CONCURRENCY_LIMIT_MAX,
  TASK_CONCURRENCY_LIMIT_MIN,
  TOOL_ROUNDS_MAX,
  TOOL_ROUNDS_MIN,
} from "@codexlike/agent-core";

/**
 * 执行设置表单解析（ADR 0017，GLOSSARY「执行设置」）：
 * 输入框文本 → 设置值。统一规则（parseIntInRange）：范围内的整数原样生效；
 * 非法/越界输入（空串、非整数、范围外）回退 fallback 默认值，回退值随保存
 * 写回输入框（用户可见回退结果）。各设置项共用同一规则、各自的合法范围与
 * 默认值常量（单一来源取自 agent-core execution-settings，与存储校验同源，
 * 防数字分叉）。
 */
function parseIntInRange(
  text: string,
  min: number,
  max: number,
  fallback: number
): number {
  // 空串/纯空白先行回退：Number("") 归一为 0，当下界为 0 的设置项（模型请求
  // 重试次数）会把「清空输入框」静默变成合法 0——先挡掉保证空输入一律回退默认
  if (text.trim() === "") {
    return fallback;
  }
  const num = Number(text);
  if (!Number.isInteger(num) || num < min || num > max) {
    return fallback;
  }
  return num;
}

/**
 * 主任务工具轮次上限解析（票 01）：合法范围 10–1000，默认 DEFAULT_MAX_TOOL_ROUNDS。
 * 子代理项（票 02）复用同一范围，默认值可指定。
 */
export function parseToolRoundsInput(
  text: string,
  fallback: number = DEFAULT_MAX_TOOL_ROUNDS
): number {
  return parseIntInRange(text, TOOL_ROUNDS_MIN, TOOL_ROUNDS_MAX, fallback);
}

/**
 * 压缩保留对话轮数解析（票 03）：合法范围 1–10，默认 DEFAULT_COMPACT_KEEP_ROUNDS；
 * 改动对下一次 /compact 生效（compact 执行时逐次读取）。
 */
export function parseCompactKeepRoundsInput(
  text: string,
  fallback: number = DEFAULT_COMPACT_KEEP_ROUNDS
): number {
  return parseIntInRange(
    text,
    COMPACT_KEEP_ROUNDS_MIN,
    COMPACT_KEEP_ROUNDS_MAX,
    fallback
  );
}

/**
 * 上下文告警阈值解析（票 03）：以整数百分比呈现与存储（UI 直观、与设置页
 * 文案一致），合法范围 50–95，默认 DEFAULT_CONTEXT_WARNING_PERCENT；消费点
 * （ui 上下文告警评估）换算为占比后传给 agent-core。
 */
export function parseContextWarningPercentInput(
  text: string,
  fallback: number = DEFAULT_CONTEXT_WARNING_PERCENT
): number {
  return parseIntInRange(
    text,
    CONTEXT_WARNING_PERCENT_MIN,
    CONTEXT_WARNING_PERCENT_MAX,
    fallback
  );
}

/**
 * MCP 工具调用超时解析（票 07）：合法范围 5–300 秒，默认
 * DEFAULT_MCP_CALL_TIMEOUT_SECONDS；宿主侧乘 1000 换算毫秒注入 manager，
 * 改动对下一次工具调用生效（逐次读取）。
 */
export function parseMcpCallTimeoutInput(
  text: string,
  fallback: number = DEFAULT_MCP_CALL_TIMEOUT_SECONDS
): number {
  return parseIntInRange(
    text,
    MCP_CALL_TIMEOUT_SECONDS_MIN,
    MCP_CALL_TIMEOUT_SECONDS_MAX,
    fallback
  );
}

/**
 * MCP 连接建立超时解析（票 07）：合法范围 5–120 秒，默认
 * DEFAULT_MCP_CONNECT_TIMEOUT_SECONDS；改动对下一次连接（含惰性自动重连）生效。
 */
export function parseMcpConnectTimeoutInput(
  text: string,
  fallback: number = DEFAULT_MCP_CONNECT_TIMEOUT_SECONDS
): number {
  return parseIntInRange(
    text,
    MCP_CONNECT_TIMEOUT_SECONDS_MIN,
    MCP_CONNECT_TIMEOUT_SECONDS_MAX,
    fallback
  );
}

/**
 * 任务并发上限解析（任务并发上限票 01，GLOSSARY「任务并发上限」）：合法范围
 * 1–8，默认 DEFAULT_TASK_CONCURRENCY_LIMIT；desktop 主进程发送闸门消费，
 * 改动对队列即时生效（调大补跑排队、调小不中断运行中）。
 */
export function parseTaskConcurrencyLimitInput(
  text: string,
  fallback: number = DEFAULT_TASK_CONCURRENCY_LIMIT
): number {
  return parseIntInRange(
    text,
    TASK_CONCURRENCY_LIMIT_MIN,
    TASK_CONCURRENCY_LIMIT_MAX,
    fallback
  );
}

/**
 * 模型请求重试次数解析（模型请求重试票 03，ADR 0024「重试不做 failover」）：
 * 合法范围 0–10（0 合法 = 完全关闭重试，调试快速失败），默认
 * DEFAULT_MODEL_MAX_RETRIES（=2，与 SDK 默认一致）；作用于对话、compact、
 * 子代理全部模型请求，对话回合/子代理运行开始快照，compact 逐次读取。
 */
export function parseModelMaxRetriesInput(
  text: string,
  fallback: number = DEFAULT_MODEL_MAX_RETRIES
): number {
  return parseIntInRange(
    text,
    MODEL_MAX_RETRIES_MIN,
    MODEL_MAX_RETRIES_MAX,
    fallback
  );
}
