/**
 * 终端会话四工具（ADR 0033 票05）：spawn_terminal / terminal_write /
 * terminal_read / terminal_kill。会话进程能力经 TerminalSessionManager
 * （宿主级单例，desktop 装配注入）承载，本文件只做工具语义：所有权过滤
 * （write/kill 仅限本任务 agent 自启会话，read 任意会话）、参数组装与
 * 中文结果格式化。
 *
 * 审批不在本文件：任务循环（agent-task.ts）按 definition.permission 与
 * commandOfToolInput 统一拦审批门（decideApproval / isRiskyCommand）——
 * spawn 的初始命令与 write 的输入字段名定为 `command`（与
 * run_terminal_command 相同字段），审批卡即可显示命令原文并按同款黑名单
 * 判定风险，不发明新机制。
 */
import type { TerminalSessionManager } from "../terminal/manager";
import type {
  TerminalReadResult,
  TerminalSessionRecord,
} from "../terminal/types";
import {
  expectString,
  optionalNumber,
  optionalString,
  parseToolArgs,
} from "./args";
import { filterEnv, type TerminalShell } from "./terminal";
import { defineTool } from "./define-tool";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "./types";

export interface TerminalSessionToolsOptions {
  /** 终端会话管理器（宿主级单例，createTerminalSessionManager 产物） */
  manager: TerminalSessionManager;
  /**
   * shell 偏好（spawn 用）：静态值或逐次解析函数。宿主注入与
   * run_terminal_command 同源的 resolver（shell 跟随执行设置）。
   */
  shell?: TerminalShell | (() => TerminalShell);
  /** 宿主完整环境变量；spawn 时按白名单过滤（不透传全部，spec 约定） */
  env?: Record<string, string | undefined>;
}

/** terminal_read 单次返回给模型的输出字符上限（与 browser_read / 终端输出同档） */
const TERMINAL_READ_MAX_CHARS = 30_000;

/** terminal_read wait=true 缺省等待毫秒数 */
const DEFAULT_READ_WAIT_MS = 10_000;
/** terminal_read 等待毫秒数上限（防模型把对话轮挂死在单次读取上） */
const MAX_READ_WAIT_MS = 60_000;
/**
 * wait 读取的分片粒度：中断响应以分为片单位（abort 后挂着的最后一个分片
 * 最多再推进 250ms 水位），单次 60s 等待不可中断地吞掉整个窗口。
 */
const READ_WAIT_SLICE_MS = 250;

function fail(message: string): ToolResult {
  return { output: message, isError: true };
}

function resolveShell(options: TerminalSessionToolsOptions): TerminalShell {
  const shell =
    typeof options.shell === "function" ? options.shell() : options.shell;
  return shell ?? "git-bash";
}

/**
 * 所有权判定（ADR 0033 关键边界）：write/kill 仅限「本任务 agent 自启」的
 * 会话（taskId 与 origin 双重判定，不是任意 origin=agent）；返回 null 表示
 * 通过，否则返回可直接回模型的中文拒绝原因。read 不走本函数（任意会话）。
 */
function requireOwnedSession(
  manager: TerminalSessionManager,
  sessionId: string,
  context: ToolExecutionContext
): { record: TerminalSessionRecord } | ToolResult {
  const record = manager.session(sessionId);
  if (record === undefined) {
    return fail(
      `终端会话不存在：${sessionId}。可用会话以工具结果或 terminal_read 返回的标识为准。`
    );
  }
  if (record.taskId !== context.taskId) {
    return fail(
      `终端会话 ${record.name} 不属于当前任务（归属：${record.taskId}），无法操作。`
    );
  }
  if (record.origin !== "agent") {
    return fail(
      `终端会话「${record.name}」由用户手动创建，只读不可操作（写入或终止需由用户在终端面板完成）。`
    );
  }
  return { record };
}

/** 中断短路（与 run_terminal_command 同款）：已 abort 的调用不再启动副作用 */
function abortedBeforeStart(context: ToolExecutionContext): boolean {
  return context.signal?.aborted === true;
}

/**
 * 把 Promise 与中断信号合并：signal 触发（或已触发）时立即得到 "aborted"，
 * 否则等待 promise 正常结果。listener 一次性移除，不残留。
 */
function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T | "aborted"> {
  if (signal === undefined) return promise;
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve("aborted");
      return;
    }
    const onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    });
  });
}

/** read 的截断格式化：超长保尾部（增量读取的语义是「追最新进展」），附中文标记 */
function formatReadOutput(result: TerminalReadResult): string {
  const lines: string[] = [];
  // 水位之前的未读被缓冲上限淘汰：警告前置（数据起点之前有缺失）
  if (result.truncated === true) {
    lines.push("[警告：会话缓冲超过 1MB 上限，本次读取之前的部分输出已被丢弃]");
  }
  let data = result.data;
  if (data.length > TERMINAL_READ_MAX_CHARS) {
    const omitted = data.length - TERMINAL_READ_MAX_CHARS;
    data = data.slice(data.length - TERMINAL_READ_MAX_CHARS);
    lines.push(
      `[输出超长：已省略前 ${omitted} 字符，仅显示最后 ${TERMINAL_READ_MAX_CHARS} 字符]`
    );
    lines.push(data);
  } else if (data.length > 0) {
    lines.push(data);
  }
  if (result.status === "exited") {
    lines.push("[会话已退出——以上是退出前的最后输出，缓冲保留可继续读取]");
  } else if (data.length === 0) {
    lines.push("[暂无新输出——会话运行中，可用 wait=true 等待新输出]");
  }
  return lines.join("\n");
}

/**
 * wait=true 的读取：按 READ_WAIT_SLICE_MS 分片轮询管理器 read，任一片有新
 * 输出 / 会话退出即返回，总预算（waitMs）耗尽返回最后一次空增量。中断信号
 * 在片间即时生效（raceWithAbort），返回 "aborted"；管理器状态不受影响——
 * 会话留存、缓冲与水位语义与正常读取一致。
 */
async function readWithWait(
  manager: TerminalSessionManager,
  sessionId: string,
  totalMs: number,
  signal: AbortSignal | undefined
): Promise<TerminalReadResult | undefined | "aborted"> {
  let remaining = totalMs;
  let last: TerminalReadResult | undefined;
  while (remaining > 0) {
    const slice = Math.min(READ_WAIT_SLICE_MS, remaining);
    remaining -= slice;
    const outcome = await raceWithAbort(
      manager.read(sessionId, { waitMs: slice }),
      signal
    );
    if (outcome === "aborted") return "aborted";
    if (outcome === undefined) return undefined;
    last = outcome;
    if (outcome.data.length > 0 || outcome.status !== "running") return outcome;
  }
  return last;
}

/** 四件终端会话工具（createBuiltinTools 在注入管理器时追加进工具表） */
export function createTerminalSessionTools(
  options: TerminalSessionToolsOptions
): ToolDefinition[] {
  const { manager } = options;

  const spawnTerminal = defineTool({
    name: "spawn_terminal",
    description:
      `启动一个持久终端会话（真 TTY：颜色、光标、交互式程序全保真），可选立即执行一条初始命令。` +
      `立即返回会话标识，不等待命令完成——适合长时间运行的命令（构建、测试、watch、数据迁移）或需要中途交互应答的场景。` +
      `会话在任务右栏终端面板可见，任务中断也不会被连带终止。` +
      `会话起始目录为任务工作区，shell 类型跟随应用执行设置。` +
      `输出用 terminal_read 增量读取，交互应答用 terminal_write，收尾用 terminal_kill。` +
      `一次性执行拿输出的短命令（ls、cat 等）请用 run_terminal_command，不必背上会话生命周期。`,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "可选的初始命令：会话启动后立即执行（如同手动键入）。缺省只启动空闲 shell。",
        },
      },
      required: [],
      additionalProperties: false,
    },
    permission: "command",
    async execute(rawArgs, context) {
      if (abortedBeforeStart(context)) {
        return fail("已被用户中断，未执行");
      }
      const args = parseToolArgs(rawArgs);
      const initialCommand = optionalString(args, "command");
      const outcome = manager.spawn({
        taskId: context.taskId,
        shell: resolveShell(options),
        origin: "agent",
        cwd: context.workspacePath,
        env: filterEnv(options.env ?? {}),
        ...(initialCommand === undefined ? {} : { initialCommand }),
      });
      if (!outcome.ok) {
        return fail(outcome.reason);
      }
      const record = manager.session(outcome.sessionId);
      const label = record?.name ?? outcome.sessionId;
      return {
        output:
          `终端会话已启动：sessionId=${outcome.sessionId}，名称「${label}」。` +
          (initialCommand === undefined
            ? "会话空闲中，可用 terminal_write 发送命令。"
            : "初始命令已提交，输出用 terminal_read 查看。") +
          "后续调用请携带本 sessionId。",
        isError: false,
      };
    },
  });

  const terminalWrite = defineTool({
    name: "terminal_write",
    description:
      `向本任务中由你（agent）启动的终端会话写入输入：交互应答（y/n 确认）、追加命令、Ctrl+C（\\u0003）等控制字符。` +
      `PTY 输入语义与手动键入一致：命令需以换行（\\n）结尾才会被执行，写入不自动回车。` +
      `用户手开的会话只读不可写。每次写入按当前审批模式逐次审批（等同于执行一条命令）。`,
    parameters: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "目标会话标识（spawn_terminal 返回）",
        },
        command: {
          type: "string",
          description:
            "要写入的输入文本（命令、按键应答等；需换行结尾才会执行）",
        },
      },
      required: ["sessionId", "command"],
      additionalProperties: false,
    },
    permission: "command",
    async execute(rawArgs, context) {
      if (abortedBeforeStart(context)) {
        return fail("已被用户中断，未执行");
      }
      const args = parseToolArgs(rawArgs);
      const sessionId = expectString(args, "sessionId");
      const command = expectString(args, "command");
      const owned = requireOwnedSession(manager, sessionId, context);
      if ("output" in owned) return owned;
      const outcome = manager.write(sessionId, command);
      if (!outcome.ok) {
        return fail(outcome.reason);
      }
      return {
        output: `已写入会话「${owned.record.name}」。输出用 terminal_read 查看。`,
        isError: false,
      };
    },
  });

  const terminalRead = defineTool({
    name: "terminal_read",
    description:
      `读取终端会话自上次读取以来的新增输出（增量水位，不重复返回已读内容）。` +
      `可读取当前任务内的任意会话：包括你自己启动的、用户手开的（帮用户诊断终端问题）、已退出的（缓冲保留，可回看崩溃前的输出）。` +
      `wait=true 时阻塞等待新输出，最长 timeoutMs 毫秒（缺省 ${DEFAULT_READ_WAIT_MS / 1000} 秒，上限 ${MAX_READ_WAIT_MS / 1000} 秒）；` +
      `缺省立即返回当前增量（可能为空）。长命令追进展建议 wait=true 一次读取而非反复轮询。`,
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "目标会话标识" },
        wait: {
          type: "boolean",
          description: "是否阻塞等待新输出（缺省 false：立即返回当前增量）",
        },
        timeoutMs: {
          type: "integer",
          description: `等待新输出的最长毫秒数（wait=true 时生效；缺省 ${DEFAULT_READ_WAIT_MS}，上限 ${MAX_READ_WAIT_MS}）`,
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    permission: "readonly",
    async execute(rawArgs, context) {
      const args = parseToolArgs(rawArgs);
      const sessionId = expectString(args, "sessionId");
      const wait = args["wait"] === true;
      const requestedTimeout = optionalNumber(args, "timeoutMs");
      const record = manager.session(sessionId);
      if (record === undefined) {
        return fail(`终端会话不存在：${sessionId}。`);
      }
      if (record.taskId !== context.taskId) {
        return fail(
          `终端会话 ${record.name} 不属于当前任务（归属：${record.taskId}），无法读取。`
        );
      }
      const waitMs = wait
        ? Math.min(
            requestedTimeout === undefined
              ? DEFAULT_READ_WAIT_MS
              : requestedTimeout,
            MAX_READ_WAIT_MS
          )
        : 0;
      const outcome =
        waitMs === 0
          ? await raceWithAbort(manager.read(sessionId), context.signal)
          : await readWithWait(manager, sessionId, waitMs, context.signal);
      if (outcome === "aborted") {
        // 中断即返：会话留存（ADR 0033），水位未消费的输出等下次读取
        return fail("已被用户中断，读取未完成；会话仍在运行。");
      }
      if (outcome === undefined) {
        return fail(`终端会话不存在：${sessionId}。`);
      }
      return { output: formatReadOutput(outcome), isError: false };
    },
  });

  const terminalKill = defineTool({
    name: "terminal_kill",
    description:
      `终止本任务中由你（agent）启动的终端会话：发送终止信号并连带终止子进程树（后台跑的构建/测试也会被一并结束）。` +
      `用户手开的会话不可终止。终止后该会话的最后输出保留为快照，可用 terminal_read 回看。` +
      `重复终止已退出的会话会得到明确提示（非幂等成功）。`,
    parameters: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "目标会话标识（spawn_terminal 返回）",
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    permission: "write",
    async execute(rawArgs, context) {
      if (abortedBeforeStart(context)) {
        return fail("已被用户中断，未执行");
      }
      const args = parseToolArgs(rawArgs);
      const sessionId = expectString(args, "sessionId");
      const owned = requireOwnedSession(manager, sessionId, context);
      if ("output" in owned) return owned;
      const outcome = manager.kill(sessionId);
      if (!outcome.ok) {
        return fail(outcome.reason);
      }
      return {
        output: `已发送终止信号：会话「${owned.record.name}」（${sessionId}）正在退出。退出后可用 terminal_read 回看最后输出。`,
        isError: false,
      };
    },
  });

  return [spawnTerminal, terminalWrite, terminalRead, terminalKill];
}
