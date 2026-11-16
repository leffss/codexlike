import { join } from "node:path";

import {
  COMPACT_KEEP_ROUNDS_MAX,
  COMPACT_KEEP_ROUNDS_MIN,
  CONTEXT_WARNING_PERCENT_MAX,
  CONTEXT_WARNING_PERCENT_MIN,
  DEFAULT_COMPACT_KEEP_ROUNDS,
  DEFAULT_CONTEXT_WARNING_PERCENT,
  DEFAULT_MAX_SUBAGENT_TOOL_ROUNDS,
  DEFAULT_MAX_TOOL_ROUNDS,
  DEFAULT_MCP_CALL_TIMEOUT_SECONDS,
  DEFAULT_MCP_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_TASK_CONCURRENCY_LIMIT,
  MCP_CALL_TIMEOUT_SECONDS_MAX,
  MCP_CALL_TIMEOUT_SECONDS_MIN,
  MCP_CONNECT_TIMEOUT_SECONDS_MAX,
  MCP_CONNECT_TIMEOUT_SECONDS_MIN,
  TASK_CONCURRENCY_LIMIT_MAX,
  TASK_CONCURRENCY_LIMIT_MIN,
  TOOL_ROUNDS_MAX,
  TOOL_ROUNDS_MIN,
} from "@codexlike/agent-core/node";

import { readJsonFile, writeJsonFile } from "../storage/json-file";

/**
 * 执行设置存储（ADR 0017，GLOSSARY「执行设置」）：agent 执行参数的用户设置，
 * 独立文件 `~/.codexlike/agent-settings.json` 持久化（与现有各设置文件同形态）。
 * 七项参数：主任务与子代理工具轮次上限（执行设置票 01/02）、压缩保留对话轮数
 * 与上下文告警阈值（票 03）、MCP 工具调用超时与连接超时（票 07，秒存储与终端
 * 超时同构）、任务并发上限（任务并发上限票 01，GLOSSARY「任务并发上限」）——
 * 前六项经内存缓存以 resolver 注入 agent-core（轮次上限回合/运行开始快照消费，
 * compact、告警阈值与 MCP 超时逐次读取），任务并发上限由 desktop 主进程发送
 * 闸门消费（不经 agent-core，ADR 0022），设置页保存后生效。
 * 各项语义独立，故独立字段、独立校验消息。
 */
export interface AgentSettings {
  /** 主任务工具轮次上限（10–1000，默认 200）；改动对下一个回合生效 */
  maxToolRounds: number;
  /** 子代理工具轮次上限（10–1000，默认 200）；改动对下一次委派生效 */
  maxSubagentToolRounds: number;
  /**
   * /compact 保留的最近原始对话轮数（1–10，默认 3）；compact 无「进行中」
   * 状态，改动对下一次压缩生效（逐次读取，无回合快照语义）
   */
  compactKeepRounds: number;
  /**
   * 上下文告警阈值，占模型上下文窗口的整数百分比（50–95，默认 80）；
   * 告警线 = 窗口（Provider Profile 逐模型可配）× 阈值，改动即时生效
   */
  contextWarningThresholdPercent: number;
  /**
   * MCP 工具调用超时（5–300 秒，默认 30；执行设置票 07）：宿主侧乘 1000
   * 换算毫秒注入 manager（与终端超时注入同构），改动对下一次工具调用生效
   */
  mcpCallTimeoutSeconds: number;
  /**
   * MCP 连接建立（spawn + initialize + tools/list）超时（5–120 秒，默认 15；
   * 执行设置票 07）：改动对下一次连接（含惰性自动重连）生效
   */
  mcpConnectTimeoutSeconds: number;
  /**
   * 任务并发上限（1–8，默认 3；任务并发上限票 01，GLOSSARY「任务并发上限」）：
   * 同时处于执行中的任务个数上限（执行中含等待用户交互）；desktop 主进程发送
   * 闸门消费，改动对队列即时生效（调大补跑排队、调小不中断运行中）
   */
  taskConcurrencyLimit: number;
}

export interface AgentSettingsStore {
  get(): Promise<AgentSettings>;
  /** 保存设置（七项各自范围与整数校验；非法输入拒绝，UI 侧先回退默认） */
  set(input: AgentSettings): Promise<AgentSettings>;
}

const FILE_NAME = "agent-settings.json";

/**
 * 读取值的收敛（防手改文件）：合法整数生效，越界/非整数等非法输入回退
 * 指定默认值。通用形态：范围由各设置项的合法范围常量决定（单一来源取自
 * agent-core execution-settings），默认值按项传入。
 */
function resolveIntInRange(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const num = typeof value === "number" ? value : Number.NaN;
  if (!Number.isInteger(num) || num < min || num > max) {
    return fallback;
  }
  return num;
}

/** 轮次上限两项共用同一合法范围（10–1000），仅默认值来源不同 */
function resolveToolRounds(value: unknown, fallback: number): number {
  return resolveIntInRange(value, TOOL_ROUNDS_MIN, TOOL_ROUNDS_MAX, fallback);
}

/**
 * 共享写入校验（纯函数）：整数且在 [min, max] 内原样返回，否则抛按项定制
 * 的中文异常（code review 修复 2：四段结构相同的校验块提炼为单一函数）。
 * store.set（存储层）与 parseAgentSettingsInput（IPC 边界解析）共用，
 * 保证两条路径的规则与消息一致；typeof 先行收窄使字符串数字（"200"）
 * 同样落入「非整数」拒绝分支，不经 Number 强转放行。
 */
function validateIntInRange(
  value: unknown,
  min: number,
  max: number,
  label: string
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${label}必须是 ${min}-${max} 的整数`);
  }
  return value;
}

/**
 * IPC 边界输入解析（纯函数，不信任渲染进程）：unknown → AgentSettings，
 * 形状/类型/范围校验任一失败以中文异常抛回（code review 修复 4：此前
 * handler 内联 Number(record[...]) 强转使 "200" 这类字符串数字放行；
 * 与 terminal-settings 的 parseTerminalSettingsInput 同构——值必须是
 * number 类型，渲染进程伪造的字符串在边界即被拒绝）。
 */
export function parseAgentSettingsInput(input: unknown): AgentSettings {
  if (typeof input !== "object" || input === null) {
    throw new Error("执行设置输入不合法");
  }
  const record = input as Record<string, unknown>;
  return {
    maxToolRounds: validateIntInRange(
      record["maxToolRounds"],
      TOOL_ROUNDS_MIN,
      TOOL_ROUNDS_MAX,
      "主任务工具轮次上限"
    ),
    maxSubagentToolRounds: validateIntInRange(
      record["maxSubagentToolRounds"],
      TOOL_ROUNDS_MIN,
      TOOL_ROUNDS_MAX,
      "子代理工具轮次上限"
    ),
    compactKeepRounds: validateIntInRange(
      record["compactKeepRounds"],
      COMPACT_KEEP_ROUNDS_MIN,
      COMPACT_KEEP_ROUNDS_MAX,
      "压缩保留对话轮数"
    ),
    contextWarningThresholdPercent: validateIntInRange(
      record["contextWarningThresholdPercent"],
      CONTEXT_WARNING_PERCENT_MIN,
      CONTEXT_WARNING_PERCENT_MAX,
      "上下文告警阈值"
    ),
    mcpCallTimeoutSeconds: validateIntInRange(
      record["mcpCallTimeoutSeconds"],
      MCP_CALL_TIMEOUT_SECONDS_MIN,
      MCP_CALL_TIMEOUT_SECONDS_MAX,
      "MCP 工具调用超时"
    ),
    mcpConnectTimeoutSeconds: validateIntInRange(
      record["mcpConnectTimeoutSeconds"],
      MCP_CONNECT_TIMEOUT_SECONDS_MIN,
      MCP_CONNECT_TIMEOUT_SECONDS_MAX,
      "MCP 连接超时"
    ),
    taskConcurrencyLimit: validateIntInRange(
      record["taskConcurrencyLimit"],
      TASK_CONCURRENCY_LIMIT_MIN,
      TASK_CONCURRENCY_LIMIT_MAX,
      "任务并发上限"
    ),
  };
}

/** 执行设置的本地存储（`~/.codexlike/agent-settings.json`）；损坏文件按默认值处理 */
export function createAgentSettingsStore(options: {
  dir: string;
}): AgentSettingsStore {
  const filePath = join(options.dir, FILE_NAME);

  function loadFile(): AgentSettings {
    // 文件不存在或损坏（非法 JSON）：默认值
    const parsed = readJsonFile<Partial<AgentSettings>>(
      filePath,
      {},
      {
        corruptAsFallback: true,
      }
    );
    return {
      maxToolRounds: resolveToolRounds(
        parsed.maxToolRounds,
        DEFAULT_MAX_TOOL_ROUNDS
      ),
      // 旧格式文件（票 01 只有主任务项）缺字段：子代理项按默认补齐
      maxSubagentToolRounds: resolveToolRounds(
        parsed.maxSubagentToolRounds,
        DEFAULT_MAX_SUBAGENT_TOOL_ROUNDS
      ),
      // 旧格式文件（票 01/02 无票 03 两项）：缺字段按默认补齐
      compactKeepRounds: resolveIntInRange(
        parsed.compactKeepRounds,
        COMPACT_KEEP_ROUNDS_MIN,
        COMPACT_KEEP_ROUNDS_MAX,
        DEFAULT_COMPACT_KEEP_ROUNDS
      ),
      contextWarningThresholdPercent: resolveIntInRange(
        parsed.contextWarningThresholdPercent,
        CONTEXT_WARNING_PERCENT_MIN,
        CONTEXT_WARNING_PERCENT_MAX,
        DEFAULT_CONTEXT_WARNING_PERCENT
      ),
      // 旧格式文件（票 01–03 无票 07 两项）：缺字段按默认补齐
      mcpCallTimeoutSeconds: resolveIntInRange(
        parsed.mcpCallTimeoutSeconds,
        MCP_CALL_TIMEOUT_SECONDS_MIN,
        MCP_CALL_TIMEOUT_SECONDS_MAX,
        DEFAULT_MCP_CALL_TIMEOUT_SECONDS
      ),
      mcpConnectTimeoutSeconds: resolveIntInRange(
        parsed.mcpConnectTimeoutSeconds,
        MCP_CONNECT_TIMEOUT_SECONDS_MIN,
        MCP_CONNECT_TIMEOUT_SECONDS_MAX,
        DEFAULT_MCP_CONNECT_TIMEOUT_SECONDS
      ),
      // 旧格式文件（任务并发上限票 01 之前只有六项）：缺字段按默认补齐
      taskConcurrencyLimit: resolveIntInRange(
        parsed.taskConcurrencyLimit,
        TASK_CONCURRENCY_LIMIT_MIN,
        TASK_CONCURRENCY_LIMIT_MAX,
        DEFAULT_TASK_CONCURRENCY_LIMIT
      ),
    };
  }

  return {
    async get() {
      return loadFile();
    },

    async set(input: AgentSettings) {
      // 六项各自校验（共享 validateIntInRange，消息与 IPC 边界解析一致）：
      // 任一项非法整体拒绝，不落盘
      const maxToolRounds = validateIntInRange(
        input.maxToolRounds,
        TOOL_ROUNDS_MIN,
        TOOL_ROUNDS_MAX,
        "主任务工具轮次上限"
      );
      const maxSubagentToolRounds = validateIntInRange(
        input.maxSubagentToolRounds,
        TOOL_ROUNDS_MIN,
        TOOL_ROUNDS_MAX,
        "子代理工具轮次上限"
      );
      const compactKeepRounds = validateIntInRange(
        input.compactKeepRounds,
        COMPACT_KEEP_ROUNDS_MIN,
        COMPACT_KEEP_ROUNDS_MAX,
        "压缩保留对话轮数"
      );
      const contextWarningThresholdPercent = validateIntInRange(
        input.contextWarningThresholdPercent,
        CONTEXT_WARNING_PERCENT_MIN,
        CONTEXT_WARNING_PERCENT_MAX,
        "上下文告警阈值"
      );
      const mcpCallTimeoutSeconds = validateIntInRange(
        input.mcpCallTimeoutSeconds,
        MCP_CALL_TIMEOUT_SECONDS_MIN,
        MCP_CALL_TIMEOUT_SECONDS_MAX,
        "MCP 工具调用超时"
      );
      const mcpConnectTimeoutSeconds = validateIntInRange(
        input.mcpConnectTimeoutSeconds,
        MCP_CONNECT_TIMEOUT_SECONDS_MIN,
        MCP_CONNECT_TIMEOUT_SECONDS_MAX,
        "MCP 连接超时"
      );
      const taskConcurrencyLimit = validateIntInRange(
        input.taskConcurrencyLimit,
        TASK_CONCURRENCY_LIMIT_MIN,
        TASK_CONCURRENCY_LIMIT_MAX,
        "任务并发上限"
      );
      const next: AgentSettings = {
        maxToolRounds,
        maxSubagentToolRounds,
        compactKeepRounds,
        contextWarningThresholdPercent,
        mcpCallTimeoutSeconds,
        mcpConnectTimeoutSeconds,
        taskConcurrencyLimit,
      };
      writeJsonFile(filePath, next);
      return next;
    },
  };
}
