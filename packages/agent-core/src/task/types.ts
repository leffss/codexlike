/**
 * 任务域类型（见 GLOSSARY.md「任务」「工作区」「工具注册表」）。
 * 全部可 JSON 序列化：TaskEvent 经 Electron IPC 转发到渲染进程，
 * StoredMessage / TaskRecord / ToolCallRecord 是持久化与 IPC 共用的形状。
 */
import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequest,
} from "./approval";
import type { ToolCallRecord } from "../tools/types";
import type {
  InteractionRecord,
  QuestionAnswerSnapshot,
} from "../interaction/types";
import type { TerminalSessionRecord } from "../terminal/types";
import type { GoalVerificationRecord } from "../goal/types";

/**
 * 任务运行状态：`idle` 空闲可发消息；`streaming` 模型回复流式进行中；
 * `waiting-approval` 工具执行暂停、等待用户审批（spec 用户故事 10，侧栏可见）
 */
export type TaskStatus =
  "idle" | "streaming" | "waiting-user" | "waiting-approval";

/**
 * 审批模式三档：`ask` 请求批准 / `assist` 帮我批准 / `full-access` 完全访问。
 * 任务级、可随时切换、随任务记录持久化（恢复用）。
 * 定义在 ./approval（工单 04 审批状态机），本文件经 import 引用。
 */

/**
 * 任务运行位置（GLOSSARY「托管 Worktree」）：`local` 本目录直跑（默认）；
 * `worktree` 托管 Worktree 隔离副本——workspacePath 指向 `~/.codexlike/worktrees/<任务id>`，
 * 由宿主在任务创建前先检出（agent-core 的 worktree 模块），落库后恢复天然指向原副本。
 */
export type WorkspaceMode = "local" | "worktree";

/** 显式项目；不依赖任务存在，工作区目录不要求是 Git 仓库。 */
export interface ProjectRecord {
  id: string;
  name: string;
  workspacePath: string;
  /** 未设置时展开；宿主持久保存。 */
  collapsed?: boolean;
  /** 未设置等价 false；展示排序由宿主决定。 */
  pinned?: boolean;
  createdAt: string;
}

/** 任务记录（tasks 表一行；重启恢复的数据来源） */
export interface TaskRecord {
  id: string;
  /** 管理归属；null 为独立任务，绝不从目录推导。 */
  projectId: string | null;
  /** 首次发送幂等键；宿主生成草稿后提交，成功后随记录持久保存。 */
  creationRequestId?: string | null;
  /** 侧栏显示名，默认取工作区目录名 */
  title: string;
  /** 绑定的工作区目录，agent 的所有文件、终端操作都被限制在其中 */
  workspacePath: string;
  /** 运行位置（本目录直跑 / 托管 Worktree）；旧库无此列恢复为 local */
  workspaceMode: WorkspaceMode;
  /** Worktree 来源目录，独立于项目归属保存；local 为 null，不作侧栏分组键。 */
  workspaceOriginPath: string | null;
  /** 最近一次发送消息所用的 Provider Profile（模型选择器「对下一条生效」的落点） */
  providerProfileId: string | null;
  /** 最近一次发送消息所用的模型标识 */
  model: string | null;
  /** 审批模式：切换对下次发送生效，当前轮冻结；新建与旧库默认 assist。 */
  approvalMode: ApprovalMode;
  /** 本任务自动批准执行审批；未设置等价 false，不改变文件访问边界。 */
  autoApprove?: boolean;
  status: TaskStatus;
  /** 归档时间（ISO 8601）；null = 未归档。归档的任务不在侧栏默认列表显示（/archive） */
  archivedAt: string | null;
  /** ISO 8601 */
  createdAt: string;
  /** 创建/发送时更新；缺省以 createdAt 排序，查看与后台事件不更新。 */
  lastUsedAt?: string;
  /** 置顶优先于最近使用；未设置等价 false。 */
  pinned?: boolean;
  /**
   * 任务用量（GLOSSARY「任务用量」，ADR 0029）：主任务累计输入 token，
   * 只增不减；未记录等价 0（旧库/新建从 0 起算，不回补估算）。
   */
  mainInputTokens?: number;
  /** 任务用量：主任务累计输出 token；未记录等价 0。 */
  mainOutputTokens?: number;
  /** 任务用量：子代理累计输入 token（并入任务总量口径）；未记录等价 0。 */
  subagentInputTokens?: number;
  /** 任务用量：子代理累计输出 token；未记录等价 0。 */
  subagentOutputTokens?: number;
  /** 记录更新时间；不作为侧栏排序依据。 */
  updatedAt: string;
}

/**
 * 任务用量增量（ADR 0029）：一次（或一组）模型调用结束时的用量入账——
 * 主任务/子代理 × 输入/输出四列各自可选，未报（中断/失败）的字段不入账记 0。
 */
export interface TaskUsageDelta {
  mainInputTokens?: number;
  mainOutputTokens?: number;
  subagentInputTokens?: number;
  subagentOutputTokens?: number;
}

/**
 * 遗留审批决定的兼容类型，不再作为运行时授权来源。
 * 新审批历史使用 InteractionRecord；任务授权保存为 TaskRecord.autoApprove。
 */
export interface ApprovalDecisionRecord {
  id: string;
  taskId: string;
  decision: "allow" | "allow-always" | "deny";
  /** 记忆主体：命令首词/前缀（如 `npm`），或工具名 */
  subject: string;
  /** ISO 8601 */
  createdAt: string;
}

/**
 * 消息角色：用户消息 / 助手回复 / 错误提示（模型 API 出错的中文提示，不进入对话上下文）/
 * 压缩摘要（/compact 生成，进入对话上下文时按 user 角色注入；消息流渲染为可展开的摘要卡片）/
 * 目标续跑指令（目标模式的内部输入，ADR 0035：进入对话上下文时按 user 角色注入并随任务
 * 落库——重启恢复与压缩都保留；但它不是用户发言，消息流不产生用户气泡）
 */
export type MessageRole =
  "user" | "assistant" | "error" | "compact-summary" | "goal-continuation";

/** 消息记录（messages 表一行） */
export interface StoredMessage {
  id: string;
  taskId: string;
  role: MessageRole;
  /** 用户原文 / 助手回复全文 / 错误提示；@引用 内容不混入（单独存 mentions） */
  content: string;
  /**
   * 该条 user 消息携带的 @引用（GLOSSARY「@ Mention」）。
   * 持久化它，重启恢复时才能把附件内容重组进模型上下文（快照等价性，工单 06）；
   * 非 user 消息与无引用的 user 消息为 undefined。
   */
  mentions?: MentionAttachment[];
  /** 本轮已提交问答；子代理答案同样归属触发它的用户消息。 */
  questionAnswers?: QuestionAnswerSnapshot[];
  /**
   * 思考过程全文（票 02，GLOSSARY「思考档位」）：随终态 assistant 消息落库，
   * 仅为重启/切回后的展示（恢复路径重建思考段）；不进入模型上下文
   * （composeStoredMessageContent 不读它，provider 层照旧剥离回传）。
   * 旧数据无此列值时自然缺失（undefined），不做补录迁移（ADR 0011）。
   */
  reasoning?: string;
  /** 助手回复被用户中断：content 为已生成的部分文本（UI 中断点标记恢复用） */
  aborted?: boolean;
  /** ISO 8601 */
  createdAt: string;
}

/**
 * 任务时间线条目：消息与工具调用按发生顺序合并（UI 消息流渲染与重启恢复用）。
 * goal-verification（ADR 0035）：目标模式每轮完成判定的结论，按判定时刻并入
 * 时间线——消息流标记行「第 N 次迭代 · 已完成/未完成」的恢复数据源；
 * 读自 goal_verifications 表，不进模型上下文（上下文组装只读 messages）。
 */
export type TranscriptItem =
  | { kind: "message"; message: StoredMessage }
  | { kind: "tool-call"; call: ToolCallRecord }
  | { kind: "interaction"; interaction: InteractionRecord }
  | { kind: "goal-verification"; verification: GoalVerificationRecord };

/**
 * @文件引用（GLOSSARY「@ Mention」）：随消息附加的工作区文件。
 * 内容由宿主读取注入（主进程校验路径在工作区内）；消息流与持久化保持用户原文。
 */
export interface MentionAttachment {
  /** 相对工作区的路径（输入框中 @token 的原样文本） */
  path: string;
  content: string;
}

/** compact 记录（compact_records 表一行；/compact 的审计与 /status「已压缩」标记数据源） */
export interface CompactRecord {
  id: string;
  taskId: string;
  /** 压缩生成的摘要全文（与 compact-summary 消息内容一致） */
  summary: string;
  /** 被压缩替换的历史消息条数（user + assistant） */
  messagesCompacted: number;
  /** ISO 8601 */
  createdAt: string;
}

/**
 * 子代理骨架状态机（ADR 0021）：`queued → running → completed | failed`；
 * `interrupted` 是应用重启启动收尾补记的终态（残留 queued/running 行的留痕），
 * 进程内正常收尾（含随主任务中断后报告回流）不会产生该状态。
 */
export type SubagentStatus =
  "queued" | "running" | "completed" | "failed" | "interrupted";

/**
 * 子代理骨架记录（subagents 表一行，ADR 0021）：委派「曾存在」的事实与起止时间。
 * 入队瞬间即写（status=queued），启动更新 running，终态更新状态与完成时间；
 * 逐轮正文与逐条工具调用在 subagent_messages / subagent_tool_calls（票 02 写入）。
 */
export interface SubagentRecord {
  id: string;
  taskId: string;
  /** 委派说明（spawn_subagent 的 task 参数原文） */
  task: string;
  status: SubagentStatus;
  /** 入队时间（ISO 8601）；骨架行随排队瞬间写入 */
  queuedAt: string;
  /** 启动时间；queued 阶段为 null */
  startedAt: string | null;
  /** 终态时间（completed / failed / interrupted）；未结束为 null */
  completedAt: string | null;
}

/**
 * 子代理逐轮消息记录（subagent_messages 表一行，ADR 0021 票 02）：
 * 一个模型轮（一次流式生成）终态写一行——content 为本轮正文、reasoning 为本轮思考，
 * 轮边界即行边界；仅为检视与导出，不进入主任务模型上下文（ADR 0021 结构性保证）。
 */
export interface SubagentMessageRecord {
  id: string;
  taskId: string;
  /** 归属的子代理（subagents.id） */
  subagentId: string;
  /** 本轮正文（流式增量拼接；纯工具轮无正文时不产生行） */
  content: string;
  /** 本轮思考；本轮无思考时缺失（读回空值归一为 undefined） */
  reasoning?: string;
  /** 轮终态时间（ISO 8601） */
  createdAt: string;
}

/**
 * 子代理工具调用记录（subagent_tool_calls 表一行，ADR 0021 票 02）：
 * 工具完成即写——output 截断口径同主代理 tool_calls（工具执行结果本身已截断）。
 */
export interface SubagentToolCallRecord {
  id: string;
  taskId: string;
  /** 归属的子代理（subagents.id） */
  subagentId: string;
  toolName: string;
  /** JSON 序列化的调用参数（与主代理 ToolCallRecord.arguments 同口径） */
  arguments: string;
  /** 截断后的执行输出 */
  output: string;
  isError: boolean;
  /** 完成时刻（ISO 8601） */
  createdAt: string;
}

/**
 * 子代理恢复快照（ADR 0021 票 03）：一个委派的骨架 + 逐轮消息 + 工具调用归组，
 * 随 view 载荷与初始 history 同一次 IPC 发给 UI（恢复数据面走并行字段而非
 * transcript 第五种 kind）——模型上下文组装只读 transcript、不读本快照，
 * 「子代理过程不进上下文」由此结构性保证（resume-equivalence 测试守护）。
 */
export interface SubagentSnapshot {
  /** 委派骨架：状态机（含重启收尾补记的 interrupted 终态）与起止时间 */
  record: SubagentRecord;
  /** 逐轮正文与思考（轮边界即行边界，按写入序） */
  messages: SubagentMessageRecord[];
  /** 工具调用清单（完成即写，按写入序） */
  toolCalls: SubagentToolCallRecord[];
}

/** /compact 的返回：压缩结果概要（IPC 转发渲染层展示用） */
export interface CompactResult {
  /** 落库后的摘要消息（compact-summary 角色，消息流渲染为摘要卡片） */
  summaryMessage: StoredMessage;
  /** 保留的最近 3 轮原始消息（重新落库后的行） */
  keptMessages: StoredMessage[];
  /** 被压缩替换的历史消息条数 */
  compactedMessages: number;
}

/**
 * 任务事件流：agent-core 聚合的流式事件，desktop 主进程按任务 ID 多路复用转发给渲染进程。
 * 一次 sendMessage 的事件序列（正常路径）：
 * `user-message → assistant-start → assistant-delta* → assistant-done`
 */
export type TaskEvent =
  | {
      type: "task-auto-approve-changed";
      taskId: string;
      autoApprove: boolean;
    }
  | { type: "interaction-request"; interaction: InteractionRecord }
  | { type: "interaction-resolved"; interaction: InteractionRecord }
  | { type: "user-message"; message: StoredMessage }
  /**
   * 目标续跑轮的内部输入（ADR 0035「续跑轮是内部输入，不产生用户气泡」）：
   * 目标模式下判定未过（或判定不可用）后由宿主发起的续跑回合，以本事件开头
   * 取代 user-message——指令已进入任务（落库为 goal-continuation 角色、进模型
   * 上下文），但消息流不呈现为用户消息。轮内的其余事件与普通回合相同。
   */
  | { type: "goal-continuation"; message: StoredMessage }
  | { type: "assistant-start"; messageId: string }
  | { type: "assistant-delta"; messageId: string; delta: string }
  /**
   * 模型思考过程的流式增量（GLOSSARY「思考档位」，OpenAI 兼容端点的 reasoning_content）。
   * 与正文（assistant-delta）分离累积：随终态消息写入 StoredMessage.reasoning
   * 仅为恢复后展示（票 02，ADR 0011）；不进入后续请求上下文
   * （provider 层已剥离回传）；终态由 assistant-done / assistant-aborted / error 一并收敛。
   */
  | { type: "assistant-reasoning"; messageId: string; delta: string }
  | { type: "assistant-done"; message: StoredMessage }
  /** 用户中断：已生成的部分文本保留为助手消息 */
  | { type: "assistant-aborted"; message: StoredMessage }
  /** 模型 API 出错：中文提示落为 error 消息，任务可继续使用 */
  | { type: "error"; message: StoredMessage }
  /**
   * 模型发起了工具调用（执行开始前；output 为空串，UI 卡片显示运行中）。
   * 审批拦截（工单 04）将发生在本事件与 tool-result 之间。
   */
  | { type: "tool-call"; call: ToolCallRecord }
  /**
   * 工具执行完成：call.output 已填（截断后）、isError 标记失败；记录同时落库。
   * 注意 isError 不等于「没执行」——被拒绝 / 参数无效 / 未注册 / 被中断的调用
   * 同样以 isError 结果收尾。executed 如实区分两者（票 05「实质工具活动」的
   * 判据：只有实际执行了的调用才算活动）：
   * - true：工具的执行器确实跑过（结果成功或出错，如命令非零退出）；
   * - false：没有执行——已被用户中断、工具未注册、参数无效、被审批策略拒绝、
   *   被用户拒绝、审批被取消；
   * - 缺省（undefined）：来源未标注，消费方按「已执行」计（保守：不把未知的
   *   调用判成空转）。
   */
  | { type: "tool-result"; call: ToolCallRecord; executed?: boolean }
  /**
   * 工具执行暂停，等待用户审批（suggest 模式下的终端命令）。
   * 发出后任务进入 waiting-approval 状态；审批响应经 respondApproval 唤醒循环。
   * 子代理的命令审批（工单 13）同样走本事件（request.subagentId 标注来源）。
   */
  | { type: "approval-request"; request: ApprovalRequest }
  /** 审批已响应：UI 据此把审批卡片转为结果态（批准 / 拒绝 / 本任务总是允许） */
  | { type: "approval-resolved"; requestId: string; decision: ApprovalDecision }
  /**
   * 子代理委派进入排队（工单 13，GLOSSARY「子代理」）：并发上限满，
   * FIFO 等待；有空位即转 subagent-start。UI 嵌套卡片显示排队状态。
   */
  | { type: "subagent-queued"; subagentId: string; task: string }
  /** 子代理开始运行（排队结束或直接有空位） */
  | {
      type: "subagent-start";
      subagentId: string;
      task: string;
      toolCallId: string;
    }
  /**
   * 子代理内部工具调用进度（嵌套卡片显示「当前活动工具」）：
   * phase=call 开始执行（运行中），phase=result 完成（含截断输出与失败标记）。
   */
  | {
      type: "subagent-tool";
      subagentId: string;
      phase: "call" | "result";
      call: ToolCallRecord;
    }
  /**
   * 子代理思考过程的流式增量（GLOSSARY「思考档位」，思考档位 03）：
   * 与报告文本分离，按 subagentId 归属各自的嵌套卡片（并发不串流）；
   * 思考全文的权威记录在子代理侧 subagent_messages（票 04 起 spawn 行
   * 不再拼接）；不回传请求历史（provider 层剥离），
   * 终态由 subagent-report 一并收敛。
   */
  | {
      type: "subagent-reasoning";
      subagentId: string;
      delta: string;
      /**
       * 显式轮键（review 修复：消灭 ui 侧轮边界双写启发式）：本次增量
       * 属于子代理第几轮流式生成（0 起，与 subagent 循环 round 计数同源）。
       * 可选字段：ui 读到时按它归并轮次，缺失（构造点未升级）时回退
       * 增量启发式（见 ui appendSubagentTurnDelta，两处口径互为镜像）。
       */
      roundIndex?: number;
    }
  /**
   * 子代理正文（报告文本）的流式增量（ADR 0021，票 02，形态对齐 subagent-reasoning）：
   * 按轮累积驱动右栏「正文」折叠块逐轮流式出现；轮终态随 subagent_messages
   * 行落库（逐轮正文与思考，轮边界即行边界），仅为检视与恢复回看；
   * 不进入主任务模型上下文，终态由 subagent-report 一并收敛。
   * roundIndex 同 subagent-reasoning（显式轮键，缺失回退启发式）。
   */
  | {
      type: "subagent-text-delta";
      subagentId: string;
      delta: string;
      roundIndex?: number;
    }
  /**
   * 子代理结束：report 为最终文本报告（回流为 spawn_subagent 的工具结果）；
   * ok=false 表示失败或被中断（report 为中文原因）。
   */
  | {
      type: "subagent-report";
      subagentId: string;
      task: string;
      report: string;
      ok: boolean;
    }
  /**
   * 终端会话启动（ADR 0033，03 票并入 TaskEvent 通道）：record 为启动时刻的
   * 完整副本，消费方不必回查管理器。PTY 字节流不走本通道（spec：专用 IPC
   * 通道直写 xterm.js，不进 React 状态）。
   */
  | { type: "terminal-started"; record: TerminalSessionRecord }
  /**
   * 终端会话退出：record 含终态（exitedAt / exitCode / 终态 64KB 快照）。
   * 迟到的残留输出不进入快照（快照定格于退出时刻）。
   */
  | { type: "terminal-exited"; record: TerminalSessionRecord }
  /**
   * 终端会话标题变化（标题功能轮）：OSC 0/2 动态写入或用户改名，record 为
   * 变化后完整副本。只进 rail 列表归并（useTerminalSessions 直连 onTaskEvent），
   * 消息流标记行保持启动时身份、不跟随标题重写历史（live-task 闸门不放行）。
   */
  | { type: "terminal-title-changed"; record: TerminalSessionRecord };
