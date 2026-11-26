import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ToolCallRecord } from "../tools/types";
import {
  GOAL_STATUSES,
  GOAL_UNAVAILABLE_REASON_PREFIX,
  GOAL_VERIFICATION_OUTCOMES,
  type GoalRecord,
  type GoalVerificationOutcome,
  type GoalVerificationRecord,
} from "../goal/types";
import type {
  InteractionRecord,
  QuestionAnswerSnapshot,
} from "../interaction/types";
import type { TerminalSessionRecord } from "../terminal/types";
import { LEGACY_APPROVAL_MODE_MAP } from "./approval";
import { createTaskSearch, type TaskSearchResult } from "./search";
import { workbenchKey } from "./workbench-state";
import type {
  CompactRecord,
  ProjectRecord,
  SubagentMessageRecord,
  SubagentRecord,
  SubagentToolCallRecord,
  TaskRecord,
  TaskUsageDelta,
  StoredMessage,
} from "./types";

/**
 * 任务持久化接口（spec「任务与持久化」节）。
 * 以接口注入：生产环境用 SQLite 文件库（`~/.codexlike/`），
 * 测试可换内存库或内存实现（ADR-0002：agent-core 可用 Node 内置 API，不依赖 Electron）。
 *
 * compact（工单 08）与审批记忆（工单 04）均已落地，各自在此接口上扩展方法。
 */
export interface TaskPersistence {
  readWorkbench(key: string): import("./workbench-state").WorkbenchEntry | null;
  writeWorkbench(
    key: string,
    entry: import("./workbench-state").WorkbenchEntry
  ): boolean;
  insertProject(record: ProjectRecord): void;
  listProjects(): ProjectRecord[];
  /** 单事务删除显式所属任务及关联记录；返回准确影响集合，不访问文件系统。 */
  removeProject(projectId: string): string[];
  isRemovedCreationRequest(requestId: string): boolean;
  setProjectCollapsed(projectId: string, collapsed: boolean): void;
  setProjectPinned(projectId: string, pinned: boolean): void;
  insertTask(record: TaskRecord): void;
  /** 仅回滚尚未写入首条消息的创建；不会删除文件或已有历史。 */
  removeUnstartedTask(id: string): void;
  /** 只更新给定字段；目标不存在时静默忽略（写入方持有内存态，读路径不经过这里） */
  updateTask(
    id: string,
    patch: Partial<Omit<TaskRecord, "id" | "createdAt">>
  ): void;
  /**
   * 任务用量累计（GLOSSARY「任务用量」，ADR 0029）：四列各自原子加 delta
   * （单条 UPDATE 即单事务）；目标不存在时静默忽略（与 updateTask 同语义）。
   */
  addTaskUsage(id: string, delta: TaskUsageDelta): void;
  insertMessage(message: StoredMessage): void;
  insertInteraction(interaction: InteractionRecord): void;
  listInteractions(taskId: string): InteractionRecord[];
  /** pending → 终态；问答快照与终态在同一事务提交，重复提交返回 false。 */
  settleInteraction(
    interaction: InteractionRecord,
    snapshot?: QuestionAnswerSnapshot
  ): boolean;
  /** 有效 pending 审批才能授予任务权限；同事务结算该任务全部 pending 审批，问答不变。 */
  approveTaskInteraction(
    taskId: string,
    requestId: string,
    resolvedAt: string
  ): InteractionRecord[] | null;
  /**
   * /compact 落地（工单 08）：单事务内把任务消息历史整体替换（摘要 + 保留轮次），
   * 并追加 compact 记录；pruneToolCallsBefore 同时清理该任务中更早的工具调用记录
   * （被压缩轮次的工具卡片随历史一起折叠进摘要）。事务保证压缩结果原子可见——
   * 旧历史要么完整保留、要么完整被替换。
   */
  replaceHistory(
    taskId: string,
    messages: StoredMessage[],
    compact: CompactRecord,
    pruneToolCallsBefore?: string
  ): void;
  /** 全部任务，置顶优先、用户最近使用倒序；后台更新不重排。 */
  listTasks(): TaskRecord[];
  searchTasks(query: string, includeArchived?: boolean): TaskSearchResult[];
  /** 指定任务的全部消息，按写入顺序；未知任务返回空数组 */
  listMessages(taskId: string): StoredMessage[];
  /** 指定任务的 compact 记录，按时间正序（最后一条为当前生效摘要） */
  listCompacts(taskId: string): CompactRecord[];
  /** 工具调用记录（一次调用完成时写入一条完整记录） */
  insertToolCall(call: ToolCallRecord): void;
  /** 指定任务的工具调用记录，按写入顺序 */
  listToolCalls(taskId: string): ToolCallRecord[];
  /** 遗留命令首词记录（兼容旧数据；不参与运行时授权；重复写入幂等）。 */
  insertApproval(taskId: string, commandWord: string): void;
  /** 读取遗留命令首词记录，仅用于兼容与历史检查，不恢复为授权。 */
  listApprovals(taskId: string): string[];
  /**
   * 子代理骨架行（ADR 0021，票 01）：入队瞬间插入（status=queued）；
   * 状态更新见 updateSubagent，按任务列出见 listSubagents。
   */
  insertSubagent(record: SubagentRecord): void;
  /**
   * 只更新状态机推进触碰的列（status / startedAt / completedAt）；
   * 归属与委派说明（taskId / task / queuedAt）建行后不变，不提供更新。
   * 目标不存在时静默忽略（与 updateTask 同语义）。
   */
  updateSubagent(
    id: string,
    patch: Partial<Pick<SubagentRecord, "status" | "startedAt" | "completedAt">>
  ): void;
  /** 指定任务的子代理骨架行，按排队时间正序；未知任务返回空数组 */
  listSubagents(taskId: string): SubagentRecord[];
  /**
   * 子代理逐轮消息（ADR 0021，票 02）：轮终态即写一行（正文 + 思考，轮边界即行边界）；
   * 按任务列出见 listSubagentMessages（恢复数据面经并行字段一次性读出，票 03）。
   */
  insertSubagentMessage(record: SubagentMessageRecord): void;
  /** 指定任务的子代理逐轮消息，按写入时间正序；未知任务返回空数组 */
  listSubagentMessages(taskId: string): SubagentMessageRecord[];
  /**
   * 子代理工具调用（ADR 0021，票 02）：完成即写一行（output 截断口径同主代理
   * insertToolCall）；按任务列出见 listSubagentToolCalls。
   */
  insertSubagentToolCall(record: SubagentToolCallRecord): void;
  /** 指定任务的子代理工具调用记录，按写入顺序；未知任务返回空数组 */
  listSubagentToolCalls(taskId: string): SubagentToolCallRecord[];
  /**
   * 终端会话骨架行（ADR 0033 票 08）：spawn 即写（status=running，终态列
   * 缺省）——「曾开过会话」的事实从创建就成立（先例 subagents 注册行
   * queued 即写）；状态推进见 updateTerminalSession，恢复读取见
   * listTerminalSessions。快照列只供回看，模型上下文组装不读本表。
   */
  insertTerminalSession(record: TerminalSessionRecord): void;
  /**
   * 只更新状态机推进触碰的列（status / exitedAt / exitCode / signal /
   * snapshot）与标题列（title / titleSource——标题功能轮：exit 事件定格
   * 时把会话终态 record 携带的最终标题随 patch 落库，重启恢复的只读回看
   * 行保留 OSC 动态值 / 用户改名）。归属与描述列（taskId / name / shell /
   * origin / createdAt）建行后不变，不提供更新。目标不存在时静默忽略（与
   * updateSubagent 同语义）。
   */
  updateTerminalSession(
    id: string,
    patch: Partial<
      Pick<
        TerminalSessionRecord,
        | "status"
        | "exitedAt"
        | "exitCode"
        | "signal"
        | "snapshot"
        | "title"
        | "titleSource"
      >
    >
  ): void;
  /** 单会话行（subscribe 回看的恢复兜底：重启后内存注册表无此会话）；不存在返回 null */
  terminalSession(sessionId: string): TerminalSessionRecord | null;
  /** 指定任务的终端会话行，按创建时间正序（rail「已退出」组恢复数据源）；未知任务返回空数组 */
  listTerminalSessions(taskId: string): TerminalSessionRecord[];
  /**
   * 重启收尾（ADR 0033 票 08）：库中残留 running 行按已退出置终态——
   * exitedAt 用收尾时刻，exitCode/signal/快照缺省（兜底置终态的容忍口径，
   * 与 01 票 killAll 兜底 record 同款）；已终态行不改写（重开幂等）。
   */
  settleRunningTerminalSessions(settledAt: string): void;
  /**
   * 目标记录（ADR 0035 票 02，GLOSSARY「目标」）：设定即写一行（status=active）；
   * 状态推进见 updateGoal，按任务列出见 listGoals。
   */
  insertGoal(record: GoalRecord): void;
  /** 指定任务的目标记录，按设定时间正序（最后一条为当前目标）；未知任务返回空数组 */
  listGoals(taskId: string): GoalRecord[];
  /** 删除目标记录（撤销尚未执行的目标）；不存在静默忽略 */
  deleteGoal(id: string): void;
  /**
   * 只更新状态机推进触碰的列（status / activeMs / activeSince / 两个连续计数 /
   * updatedAt）、编辑目标触碰的 text 与调整预算触碰的 budgetTokens；归属与
   * 设定时间（taskId / createdAt）、对账基线（baselineTokens）建行后不变。
   * 目标不存在时静默忽略（与 updateTask 同语义）。
   */
  updateGoal(
    id: string,
    patch: Partial<
      Pick<
        GoalRecord,
        | "status"
        | "text"
        | "activeMs"
        | "activeSince"
        | "idleStreak"
        | "failureStreak"
        | "budgetTokens"
        | "updatedAt"
      >
    >
  ): void;
  /**
   * 逐轮验证记录（ADR 0035 票 02，GLOSSARY「完成判定」）：每轮判定结束即写一行
   * （轮次、结论种类、理由、下一步方向、本轮是否有实质工具活动、时间戳）；
   * 按任务列出见 listGoalVerifications。
   */
  insertGoalVerification(record: GoalVerificationRecord): void;
  /**
   * 指定任务的全部验证记录（含已清除/已完成目标的历次记录，随任务留痕），
   * 按判定时间正序；未知任务返回空数组。
   */
  listGoalVerifications(taskId: string): GoalVerificationRecord[];
  /** 释放数据库句柄（宿主退出前调用；Windows 上未关闭会锁住库文件） */
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workbench_state (
  key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS removed_creation_requests (
  request_id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  provider_profile_id TEXT,
  model TEXT,
  status TEXT NOT NULL,
  approval_mode TEXT NOT NULL DEFAULT 'assist',
  workspace_mode TEXT NOT NULL DEFAULT 'local',
  workspace_origin_path TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  main_input_tokens INTEGER NOT NULL DEFAULT 0,
  main_output_tokens INTEGER NOT NULL DEFAULT 0,
  subagent_input_tokens INTEGER NOT NULL DEFAULT 0,
  subagent_output_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  mentions TEXT,
  aborted INTEGER,
  reasoning TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_task_created
  ON messages(task_id, created_at);
CREATE TABLE IF NOT EXISTS compact_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  messages_compacted INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  arguments TEXT NOT NULL,
  output TEXT NOT NULL,
  is_error INTEGER NOT NULL,
  reasoning TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_task_created
  ON tool_calls(task_id, created_at);
CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  record TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interactions_task ON interactions(task_id, created_at);
CREATE TABLE IF NOT EXISTS approvals (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  command_word TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, command_word)
);
CREATE TABLE IF NOT EXISTS subagents (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_subagents_task_queued
  ON subagents(task_id, queued_at);
CREATE TABLE IF NOT EXISTS subagent_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  subagent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subagent_messages_subagent
  ON subagent_messages(task_id, subagent_id, created_at);
CREATE TABLE IF NOT EXISTS subagent_tool_calls (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  subagent_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments TEXT NOT NULL,
  output TEXT NOT NULL,
  is_error INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subagent_tool_calls_subagent
  ON subagent_tool_calls(task_id, subagent_id, created_at);
CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  origin TEXT NOT NULL,
  shell TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  exited_at TEXT,
  exit_code INTEGER,
  signal INTEGER,
  title TEXT,
  title_source TEXT,
  snapshot TEXT
);
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_task
  ON terminal_sessions(task_id, created_at);
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  active_ms INTEGER NOT NULL DEFAULT 0,
  active_since TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  idle_streak INTEGER NOT NULL DEFAULT 0,
  failure_streak INTEGER NOT NULL DEFAULT 0,
  budget_tokens INTEGER,
  baseline_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_goals_task_created
  ON goals(task_id, created_at);
CREATE TABLE IF NOT EXISTS goal_verifications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  goal_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  reason TEXT NOT NULL,
  next_action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT '',
  tool_activity INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_goal_verifications_task
  ON goal_verifications(task_id, created_at);
`;

interface TaskRow {
  id: string;
  project_id: string | null;
  creation_request_id: string | null;
  title: string;
  workspace_path: string;
  provider_profile_id: string | null;
  model: string | null;
  status: string;
  approval_mode: string;
  auto_approve: number;
  workspace_mode: string;
  workspace_origin_path: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  pinned: number;
  last_used_at: string | null;
  main_input_tokens: number;
  main_output_tokens: number;
  subagent_input_tokens: number;
  subagent_output_tokens: number;
}

interface MessageRow {
  id: string;
  task_id: string;
  role: string;
  content: string;
  created_at: string;
  mentions: string | null;
  aborted: number | null;
  question_answers: string | null;
  reasoning: string | null;
}

interface CompactRow {
  id: string;
  task_id: string;
  summary: string;
  messages_compacted: number;
  created_at: string;
}

interface ToolCallRow {
  id: string;
  task_id: string;
  tool_name: string;
  arguments: string;
  output: string;
  is_error: number;
  reasoning: string | null;
  created_at: string;
}

interface SubagentRow {
  id: string;
  task_id: string;
  task: string;
  status: string;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface SubagentMessageRow {
  id: string;
  task_id: string;
  subagent_id: string;
  content: string;
  reasoning: string | null;
  created_at: string;
}

interface SubagentToolCallRow {
  id: string;
  task_id: string;
  subagent_id: string;
  tool_name: string;
  arguments: string;
  output: string;
  is_error: number;
  created_at: string;
}

interface TerminalSessionRow {
  id: string;
  task_id: string;
  name: string;
  origin: string;
  shell: string;
  status: string;
  created_at: string;
  exited_at: string | null;
  exit_code: number | null;
  signal: number | null;
  title: string | null;
  title_source: string | null;
  snapshot: string | null;
}

interface GoalRow {
  id: string;
  task_id: string;
  text: string;
  status: string;
  active_ms: number;
  active_since: string | null;
  created_at: string;
  updated_at: string;
  idle_streak: number;
  failure_streak: number;
  budget_tokens: number | null;
  baseline_tokens: number;
}

interface GoalVerificationRow {
  id: string;
  task_id: string;
  goal_id: string;
  round: number;
  passed: number;
  reason: string;
  next_action: string;
  created_at: string;
  outcome: string;
  tool_activity: number;
}

/**
 * 验证记录的结论种类（读侧）：票 02 时代的旧行没有 outcome 列（取列默认值
 * 空串）——按 passed 与理由回推：通过即 passed；理由以「完成判定不可用」开头
 * 为 unavailable；其余为 unpassed。非法值同样回推，不把未知种类漏到界面。
 * 这是回推启发式：匹配锚与 verifier 拼的文案同源，都依赖
 * GOAL_UNAVAILABLE_REASON_PREFIX——旧库 reason 是历史文本，改该常量值会匹配
 * 不上、把 unavailable 误判为 unpassed。
 */
function verificationOutcomeOf(
  row: GoalVerificationRow
): GoalVerificationOutcome {
  if ((GOAL_VERIFICATION_OUTCOMES as readonly string[]).includes(row.outcome))
    return row.outcome as GoalVerificationOutcome;
  if (row.passed === 1) return "passed";
  return row.reason.includes(GOAL_UNAVAILABLE_REASON_PREFIX)
    ? "unavailable"
    : "unpassed";
}

/**
 * 基于 node:sqlite（Node 22.13+ / Electron 45 内置，无原生编译依赖）的任务存储。
 * 单条语句写入即单个事务（SQLite 语义），断电安全。
 * 测试传 `:memory:` 得到内存库。
 */
export function createSqliteTaskStore(dbPath: string): TaskPersistence {
  // 父目录不存在时自建（SQLite 不会创建目录）：打包后首次启动 ~/.codexlike
  // 尚未建立，宿主也未统一 mkdir，这里不自建则 whenReady 链在第一步即断
  // （2026-11-11 打包黑屏事故）。`:memory:` 时 dirname 为 "."，mkdir 空操作。
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  // 旧库迁移：工单 02 时代的 tasks 表没有 archived_at（工单 07）、
  // 工单 03 时代没有 approval_mode（工单 04 审批三档）
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN archived_at TEXT");
  } catch {
    // 列已存在（新库或已迁移）
  }
  try {
    db.exec(
      "ALTER TABLE tasks ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'assist'"
    );
  } catch {
    // 列已存在（新库或已迁移）
  }
  // 旧库迁移：工单 08 时代的 tasks 表没有 workspace_mode（工单 09 托管 Worktree）
  try {
    db.exec(
      "ALTER TABLE tasks ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'local'"
    );
  } catch {
    // 列已存在（新库或已迁移）
  }
  // 旧库迁移：ADR 0005（项目侧栏按原始仓库聚合）之前的表没有 workspace_origin_path
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN workspace_origin_path TEXT");
  } catch {
    // 列已存在（新库或已迁移）
  }
  // 旧库迁移：工单 03 时代的 messages 表没有 mentions / aborted（工单 06 恢复等价性需要）
  try {
    db.exec("ALTER TABLE messages ADD COLUMN mentions TEXT");
  } catch {
    // 列已存在
  }
  try {
    db.exec("ALTER TABLE messages ADD COLUMN aborted INTEGER");
  } catch {
    // 列已存在
  }

  const messageColumns = db.prepare("PRAGMA table_info(messages)").all();
  if (!messageColumns.some((column) => column.name === "question_answers")) {
    db.exec("ALTER TABLE messages ADD COLUMN question_answers TEXT");
  }
  // 旧库迁移（票 02，ADR 0011）：messages 无 reasoning 列——思考随终态消息落库，
  // 旧数据自然缺失（读回 undefined），不做补录迁移
  if (!messageColumns.some((column) => column.name === "reasoning")) {
    db.exec("ALTER TABLE messages ADD COLUMN reasoning TEXT");
  }
  // 旧库迁移（票 02）：tool_calls 无 reasoning 列——子代理思考随委派记录落库
  const toolCallColumns = db.prepare("PRAGMA table_info(tool_calls)").all();
  if (!toolCallColumns.some((column) => column.name === "reasoning")) {
    db.exec("ALTER TABLE tool_calls ADD COLUMN reasoning TEXT");
  }

  const taskColumns = db.prepare("PRAGMA table_info(tasks)").all();
  if (!taskColumns.some((column) => column.name === "auto_approve"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0"
    );
  if (!taskColumns.some((column) => column.name === "project_id"))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id)"
    );
  if (!taskColumns.some((column) => column.name === "creation_request_id"))
    db.exec("ALTER TABLE tasks ADD COLUMN creation_request_id TEXT");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_creation_request ON tasks(creation_request_id)"
  );
  const projectColumns = db.prepare("PRAGMA table_info(projects)").all();
  if (!projectColumns.some((column) => column.name === "collapsed"))
    db.exec(
      "ALTER TABLE projects ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0"
    );
  if (!projectColumns.some((column) => column.name === "pinned"))
    db.exec(
      "ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"
    );
  if (!taskColumns.some((column) => column.name === "pinned"))
    db.exec("ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  if (!taskColumns.some((column) => column.name === "last_used_at"))
    db.exec("ALTER TABLE tasks ADD COLUMN last_used_at TEXT");
  // 旧库迁移（ADR 0029，任务用量）：无用量列——主/子代理 × 输入/输出聚合记账，
  // 旧行默认 0（真实 usage 自上线起累计，不回补估算）
  for (const column of [
    "main_input_tokens",
    "main_output_tokens",
    "subagent_input_tokens",
    "subagent_output_tokens",
  ]) {
    if (!taskColumns.some((existing) => existing.name === column))
      db.exec(
        `ALTER TABLE tasks ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`
      );
  }
  // 旧库迁移（标题功能轮，ADR 0033 后续）：terminal_sessions 无标题列——
  // OSC 动态值 / 用户改名随 exit 终态落库，重启恢复的只读回看行保留标题；
  // 旧行 NULL（读回缺省回退 name 呈现）
  const terminalColumns = db
    .prepare("PRAGMA table_info(terminal_sessions)")
    .all();
  if (!terminalColumns.some((column) => column.name === "title"))
    db.exec("ALTER TABLE terminal_sessions ADD COLUMN title TEXT");
  if (!terminalColumns.some((column) => column.name === "title_source"))
    db.exec("ALTER TABLE terminal_sessions ADD COLUMN title_source TEXT");
  // 旧库迁移（goal-mode 票 03）：票 02 时代的两张目标表没有连续计数与结论
  // 种类列——旧行取列默认值（计数 0；结论种类读侧按 passed / 理由回推，
  // 是否有工具活动未知时按「有」计，不把历史轮次误判为空转）
  const goalColumns = db.prepare("PRAGMA table_info(goals)").all();
  for (const column of ["idle_streak", "failure_streak"]) {
    if (!goalColumns.some((existing) => existing.name === column))
      db.exec(
        `ALTER TABLE goals ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`
      );
  }
  // 旧库迁移（goal-mode 票 05）：goals 表没有预算与对账基线列——旧行未设预算
  // （NULL = 不限，预算护栏对既有目标不生效）、基线 0
  if (!goalColumns.some((existing) => existing.name === "budget_tokens"))
    db.exec("ALTER TABLE goals ADD COLUMN budget_tokens INTEGER");
  if (!goalColumns.some((existing) => existing.name === "baseline_tokens"))
    db.exec(
      "ALTER TABLE goals ADD COLUMN baseline_tokens INTEGER NOT NULL DEFAULT 0"
    );
  const goalVerificationColumns = db
    .prepare("PRAGMA table_info(goal_verifications)")
    .all();
  if (!goalVerificationColumns.some((column) => column.name === "outcome"))
    db.exec(
      "ALTER TABLE goal_verifications ADD COLUMN outcome TEXT NOT NULL DEFAULT ''"
    );
  if (
    !goalVerificationColumns.some((column) => column.name === "tool_activity")
  )
    db.exec(
      "ALTER TABLE goal_verifications ADD COLUMN tool_activity INTEGER NOT NULL DEFAULT 1"
    );
  const insertTask = db.prepare(
    "INSERT INTO tasks (id, title, workspace_path, provider_profile_id, model, status, approval_mode, workspace_mode, workspace_origin_path, archived_at, created_at, updated_at, project_id, creation_request_id, pinned, last_used_at, auto_approve, main_input_tokens, main_output_tokens, subagent_input_tokens, subagent_output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const updateTaskStmt = db.prepare(
    "UPDATE tasks SET title = ?, workspace_path = ?, provider_profile_id = ?, model = ?, status = ?, approval_mode = ?, workspace_mode = ?, workspace_origin_path = ?, archived_at = ?, updated_at = ?, pinned = ?, last_used_at = ?, project_id = ?, auto_approve = ? WHERE id = ?"
  );
  const insertMessageStmt = db.prepare(
    "INSERT INTO messages (id, task_id, role, content, created_at, mentions, aborted, question_answers, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const listTasksStmt = db.prepare(
    "SELECT * FROM tasks ORDER BY pinned DESC, COALESCE(last_used_at, created_at) DESC, created_at DESC, id DESC"
  );
  const listMessagesStmt = db.prepare(
    "SELECT * FROM messages WHERE task_id = ? ORDER BY created_at, rowid"
  );
  const deleteMessagesStmt = db.prepare(
    "DELETE FROM messages WHERE task_id = ?"
  );
  const deleteToolCallsBeforeStmt = db.prepare(
    "DELETE FROM tool_calls WHERE task_id = ? AND created_at < ?"
  );
  const insertCompactStmt = db.prepare(
    "INSERT INTO compact_records (id, task_id, summary, messages_compacted, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  const listCompactsStmt = db.prepare(
    "SELECT * FROM compact_records WHERE task_id = ? ORDER BY created_at, rowid"
  );
  const insertToolCallStmt = db.prepare(
    "INSERT INTO tool_calls (id, task_id, tool_name, arguments, output, is_error, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const listToolCallsStmt = db.prepare(
    "SELECT * FROM tool_calls WHERE task_id = ? ORDER BY created_at, rowid"
  );
  const insertApprovalStmt = db.prepare(
    "INSERT OR IGNORE INTO approvals (task_id, command_word, created_at) VALUES (?, ?, ?)"
  );
  const listApprovalsStmt = db.prepare(
    "SELECT command_word FROM approvals WHERE task_id = ? ORDER BY created_at, rowid"
  );
  const insertSubagentStmt = db.prepare(
    "INSERT INTO subagents (id, task_id, task, status, queued_at, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const listSubagentsStmt = db.prepare(
    "SELECT * FROM subagents WHERE task_id = ? ORDER BY queued_at, rowid"
  );
  const insertSubagentMessageStmt = db.prepare(
    "INSERT INTO subagent_messages (id, task_id, subagent_id, content, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const listSubagentMessagesStmt = db.prepare(
    "SELECT * FROM subagent_messages WHERE task_id = ? ORDER BY created_at, rowid"
  );
  const insertSubagentToolCallStmt = db.prepare(
    "INSERT INTO subagent_tool_calls (id, task_id, subagent_id, tool_name, arguments, output, is_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const listSubagentToolCallsStmt = db.prepare(
    "SELECT * FROM subagent_tool_calls WHERE task_id = ? ORDER BY created_at, rowid"
  );
  const insertTerminalSessionStmt = db.prepare(
    "INSERT INTO terminal_sessions (id, task_id, name, origin, shell, status, created_at, exited_at, exit_code, signal, title, title_source, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const listTerminalSessionsStmt = db.prepare(
    "SELECT * FROM terminal_sessions WHERE task_id = ? ORDER BY created_at, rowid"
  );
  const insertGoalStmt = db.prepare(
    "INSERT INTO goals (id, task_id, text, status, active_ms, active_since, created_at, updated_at, idle_streak, failure_streak, budget_tokens, baseline_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const listGoalsStmt = db.prepare(
    "SELECT * FROM goals WHERE task_id = ? ORDER BY created_at, rowid"
  );
  const insertGoalVerificationStmt = db.prepare(
    "INSERT INTO goal_verifications (id, task_id, goal_id, round, passed, reason, next_action, created_at, outcome, tool_activity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const listGoalVerificationsStmt = db.prepare(
    "SELECT * FROM goal_verifications WHERE task_id = ? ORDER BY created_at, rowid"
  );

  function toRecord(row: TaskRow): TaskRecord {
    return {
      id: row.id,
      projectId: row.project_id ?? null,
      creationRequestId: row.creation_request_id ?? null,
      title: row.title,
      workspacePath: row.workspace_path,
      providerProfileId: row.provider_profile_id,
      model: row.model,
      status:
        row.status === "waiting-approval"
          ? "waiting-user"
          : (row.status as TaskRecord["status"]),
      // 审批模式读侧迁移（ADR 0004，不回写数据）：旧三档值映射到新三档
      // （readonly→ask、suggest→assist、full→full-access）；
      // 非法/缺失/损坏值恢复为默认档 assist
      approvalMode:
        row.approval_mode === "ask" ||
        row.approval_mode === "assist" ||
        row.approval_mode === "full-access"
          ? row.approval_mode
          : (LEGACY_APPROVAL_MODE_MAP[row.approval_mode] ?? "assist"),
      // 运行位置：非法/缺失值恢复为 local（本目录直跑）
      workspaceMode: row.workspace_mode === "worktree" ? "worktree" : "local",
      // 原始仓库路径（ADR 0005）：旧库 / local 任务 / 旧 worktree 任务均为 null
      workspaceOriginPath: row.workspace_origin_path ?? null,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      autoApprove: row.auto_approve === 1,
      pinned: row.pinned === 1,
      lastUsedAt: row.last_used_at ?? row.created_at,
      // 任务用量四列（ADR 0029）：迁移后 NOT NULL DEFAULT 0，读回恒有值
      mainInputTokens: row.main_input_tokens ?? 0,
      mainOutputTokens: row.main_output_tokens ?? 0,
      subagentInputTokens: row.subagent_input_tokens ?? 0,
      subagentOutputTokens: row.subagent_output_tokens ?? 0,
    };
  }

  /** 写入一条消息（含 @引用、中断标记与思考列；insertMessage 与 replaceHistory 共用） */
  function insertMessage(message: StoredMessage): void {
    insertMessageStmt.run(
      message.id,
      message.taskId,
      message.role,
      message.content,
      message.createdAt,
      message.mentions === undefined || message.mentions.length === 0
        ? null
        : JSON.stringify(message.mentions),
      message.aborted === true ? 1 : 0,
      message.questionAnswers?.length
        ? JSON.stringify(message.questionAnswers)
        : null,
      message.reasoning || null
    );
  }

  /** terminal_sessions 行 → record：NULL 列读回字段缺省（兜底置终态容忍口径） */
  function terminalRecordOf(row: TerminalSessionRow): TerminalSessionRecord {
    return {
      sessionId: row.id,
      taskId: row.task_id,
      name: row.name,
      shell: row.shell as TerminalSessionRecord["shell"],
      origin: row.origin as TerminalSessionRecord["origin"],
      status: row.status as TerminalSessionRecord["status"],
      createdAt: row.created_at,
      ...(row.title !== null ? { title: row.title } : {}),
      ...(row.title_source !== null
        ? {
            titleSource:
              row.title_source as TerminalSessionRecord["titleSource"],
          }
        : {}),
      ...(row.exited_at !== null ? { exitedAt: row.exited_at } : {}),
      ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
      ...(row.signal !== null ? { signal: row.signal } : {}),
      ...(row.snapshot !== null ? { snapshot: row.snapshot } : {}),
    };
  }

  return {
    readWorkbench(key) {
      const row = db
        .prepare("SELECT revision, value FROM workbench_state WHERE key = ?")
        .get(key);
      return row
        ? {
            revision: Number(row.revision),
            value: JSON.parse(String(row.value)),
          }
        : null;
    },
    writeWorkbench(key, entry) {
      return (
        db
          .prepare(
            `INSERT INTO workbench_state (key, revision, value) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET revision = excluded.revision, value = excluded.value
        WHERE excluded.revision > workbench_state.revision`
          )
          .run(key, entry.revision, JSON.stringify(entry.value)).changes > 0
      );
    },
    searchTasks: createTaskSearch(db),
    insertProject(record) {
      db.prepare(
        "INSERT INTO projects (id, name, workspace_path, created_at, pinned) VALUES (?, ?, ?, ?, ?)"
      ).run(
        record.id,
        record.name,
        record.workspacePath,
        record.createdAt,
        record.pinned ? 1 : 0
      );
    },
    isRemovedCreationRequest(requestId) {
      return (
        db
          .prepare(
            "SELECT 1 FROM removed_creation_requests WHERE request_id = ?"
          )
          .get(requestId) !== undefined
      );
    },
    removeProject(projectId) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const members = db
          .prepare("SELECT id FROM tasks WHERE project_id = ?")
          .all(projectId);
        const deleteWorkbench = db.prepare(
          "DELETE FROM workbench_state WHERE key = ?"
        );
        deleteWorkbench.run(workbenchKey({ kind: "new", projectId }));
        for (const member of members)
          deleteWorkbench.run(
            workbenchKey({ kind: "task", taskId: String(member.id) })
          );
        // 成功创建意图保留墓碑，避免移入后移除的独立草稿因重试重建任务。
        db.prepare(
          "INSERT OR IGNORE INTO removed_creation_requests SELECT creation_request_id FROM tasks WHERE project_id = ? AND creation_request_id IS NOT NULL"
        ).run(projectId);
        // 显式关联清理，不依赖各运行时 foreign_keys 默认值，不按目录推导集合。
        // 子代理三表随任务数据同步清理（ADR 0021：生命周期跟随任务数据）；
        // 目标两表同理（ADR 0035：目标与逐轮验证记录随任务留痕、随任务清理）。
        for (const table of [
          "messages",
          "compact_records",
          "tool_calls",
          "interactions",
          "approvals",
          "subagents",
          "subagent_messages",
          "subagent_tool_calls",
          "terminal_sessions",
          "goals",
          "goal_verifications",
        ]) {
          db.prepare(
            `DELETE FROM ${table} WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)`
          ).run(projectId);
        }
        db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
        db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
        db.exec("COMMIT");
        return members.map((row) => String(row.id));
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    setProjectCollapsed(projectId, collapsed) {
      db.prepare("UPDATE projects SET collapsed = ? WHERE id = ?").run(
        collapsed ? 1 : 0,
        projectId
      );
    },
    setProjectPinned(projectId, pinned) {
      db.prepare("UPDATE projects SET pinned = ? WHERE id = ?").run(
        pinned ? 1 : 0,
        projectId
      );
    },
    listProjects() {
      return db
        .prepare("SELECT * FROM projects ORDER BY created_at, rowid")
        .all()
        .map((row) => ({
          id: String(row.id),
          name: String(row.name),
          workspacePath: String(row.workspace_path),
          collapsed: row.collapsed === 1,
          pinned: row.pinned === 1,
          createdAt: String(row.created_at),
        }));
    },
    insertTask(record) {
      insertTask.run(
        record.id,
        record.title,
        record.workspacePath,
        record.providerProfileId,
        record.model,
        record.status,
        record.approvalMode,
        record.workspaceMode,
        record.workspaceOriginPath,
        record.archivedAt,
        record.createdAt,
        record.updatedAt,
        record.projectId ?? null,
        record.creationRequestId ?? null,
        record.pinned ? 1 : 0,
        record.lastUsedAt ?? record.createdAt,
        record.autoApprove ? 1 : 0,
        record.mainInputTokens ?? 0,
        record.mainOutputTokens ?? 0,
        record.subagentInputTokens ?? 0,
        record.subagentOutputTokens ?? 0
      );
    },
    removeUnstartedTask(id) {
      db.prepare(
        "DELETE FROM tasks WHERE id = ? AND NOT EXISTS (SELECT 1 FROM messages WHERE task_id = ?)"
      ).run(id, id);
    },

    updateTask(id, patch) {
      const current = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
        TaskRow | undefined;
      if (current === undefined) {
        return;
      }
      const next = { ...toRecord(current), ...patch };
      updateTaskStmt.run(
        next.title,
        next.workspacePath,
        next.providerProfileId,
        next.model,
        next.status,
        next.approvalMode,
        next.workspaceMode,
        next.workspaceOriginPath,
        next.archivedAt,
        next.updatedAt,
        next.pinned ? 1 : 0,
        next.lastUsedAt ?? next.createdAt,
        next.projectId ?? null,
        next.autoApprove ? 1 : 0,
        id
      );
    },

    addTaskUsage(id, delta) {
      // 只增不减的原子累加（单条 UPDATE 即单事务）；未报的字段（中断/失败）跳过
      const columns: string[] = [];
      const values: number[] = [];
      const fields: [keyof TaskUsageDelta, string][] = [
        ["mainInputTokens", "main_input_tokens"],
        ["mainOutputTokens", "main_output_tokens"],
        ["subagentInputTokens", "subagent_input_tokens"],
        ["subagentOutputTokens", "subagent_output_tokens"],
      ];
      for (const [field, column] of fields) {
        const amount = delta[field];
        if (amount !== undefined && amount > 0) {
          columns.push(`${column} = ${column} + ?`);
          values.push(amount);
        }
      }
      if (columns.length === 0) {
        return;
      }
      db.prepare(`UPDATE tasks SET ${columns.join(", ")} WHERE id = ?`).run(
        ...values,
        id
      );
    },

    insertMessage(message) {
      insertMessage(message);
    },

    insertInteraction(interaction) {
      db.prepare(
        "INSERT INTO interactions (id, task_id, record, created_at) VALUES (?, ?, ?, ?)"
      ).run(
        interaction.request.id,
        interaction.request.taskId,
        JSON.stringify(interaction),
        interaction.request.createdAt
      );
    },

    listInteractions(taskId) {
      return db
        .prepare(
          "SELECT record FROM interactions WHERE task_id = ? ORDER BY created_at, rowid"
        )
        .all(taskId)
        .map((row) => JSON.parse(String(row.record)) as InteractionRecord);
    },

    settleInteraction(interaction, snapshot) {
      db.exec("BEGIN");
      try {
        const row = db
          .prepare(
            "SELECT record FROM interactions WHERE id = ? AND task_id = ?"
          )
          .get(interaction.request.id, interaction.request.taskId);
        if (
          !row ||
          (JSON.parse(String(row.record)) as InteractionRecord).status !==
            "pending"
        ) {
          db.exec("ROLLBACK");
          return false;
        }
        if (snapshot !== undefined) {
          const message = db
            .prepare(
              "SELECT question_answers FROM messages WHERE id = ? AND task_id = ? AND role = 'user'"
            )
            .get(interaction.request.turnId, interaction.request.taskId);
          if (!message)
            throw new Error("交互所属的用户消息不存在，无法保存回答");
          const answers = message.question_answers
            ? (JSON.parse(
                String(message.question_answers)
              ) as QuestionAnswerSnapshot[])
            : [];
          answers.push(snapshot);
          db.prepare(
            "UPDATE messages SET question_answers = ? WHERE id = ?"
          ).run(JSON.stringify(answers), interaction.request.turnId);
        }
        db.prepare("UPDATE interactions SET record = ? WHERE id = ?").run(
          JSON.stringify(interaction),
          interaction.request.id
        );
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    approveTaskInteraction(taskId, requestId, resolvedAt) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const records = db
          .prepare(
            "SELECT record FROM interactions WHERE task_id = ? ORDER BY created_at, rowid"
          )
          .all(taskId)
          .map((row) => JSON.parse(String(row.record)) as InteractionRecord);
        const pending = records.filter(
          (record) =>
            record.status === "pending" && record.request.kind === "approval"
        );
        if (
          !pending.some((record) => record.request.id === requestId) ||
          !db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId)
        ) {
          db.exec("ROLLBACK");
          return null;
        }
        const waiting = records.some(
          (record) =>
            record.status === "pending" && record.request.kind === "questions"
        );
        db.prepare(
          "UPDATE tasks SET auto_approve = 1, status = ?, updated_at = ? WHERE id = ?"
        ).run(waiting ? "waiting-user" : "streaming", resolvedAt, taskId);
        const settled = pending.map((record): InteractionRecord => ({
          ...record,
          status: "resolved",
          resolvedAt,
          response: { kind: "approval", decision: "approve", scope: "task" },
        }));
        const update = db.prepare(
          "UPDATE interactions SET record = ? WHERE id = ? AND task_id = ?"
        );
        for (const record of settled)
          update.run(JSON.stringify(record), record.request.id, taskId);
        db.exec("COMMIT");
        return settled;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    replaceHistory(taskId, messages, compact, pruneToolCallsBefore) {
      // 单事务：删除旧消息 + 写入新历史（摘要 + 保留轮次）+ 追加 compact 记录
      // + 清理被压缩轮次的工具调用记录，原子落地（中途失败整体回滚，旧历史不受损）。
      // 重写消息复用 insertMessage（含 mentions / aborted 列）：
      // 保留轮次携带的 @引用 与中断标记在 compact 重写后不丢（恢复等价性，工单 06）
      db.exec("BEGIN");
      try {
        deleteMessagesStmt.run(taskId);
        for (const message of messages) {
          insertMessage(message);
        }
        insertCompactStmt.run(
          compact.id,
          compact.taskId,
          compact.summary,
          compact.messagesCompacted,
          compact.createdAt
        );
        if (pruneToolCallsBefore !== undefined) {
          deleteToolCallsBeforeStmt.run(taskId, pruneToolCallsBefore);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    listTasks() {
      return (listTasksStmt.all() as unknown as TaskRow[]).map(toRecord);
    },

    listMessages(taskId) {
      return (listMessagesStmt.all(taskId) as unknown as MessageRow[]).map(
        (row) => {
          const message: StoredMessage = {
            id: row.id,
            taskId: row.task_id,
            role: row.role as StoredMessage["role"],
            content: row.content,
            createdAt: row.created_at,
          };
          // mentions JSON 反序列化：损坏数据视作无引用（不阻塞恢复）
          if (row.mentions !== null && row.mentions !== "") {
            try {
              const parsed = JSON.parse(row.mentions) as unknown;
              if (Array.isArray(parsed)) {
                message.mentions = parsed as StoredMessage["mentions"];
              }
            } catch {
              // 忽略损坏的 mentions 列
            }
          }
          if (row.question_answers) {
            try {
              const parsed: unknown = JSON.parse(row.question_answers);
              if (Array.isArray(parsed)) message.questionAnswers = parsed;
            } catch {
              // 损坏的旧数据不阻塞历史读取。
            }
          }
          if (row.aborted === 1) {
            message.aborted = true;
          }
          // 思考全文（票 02）：空串归一为缺失（恢复侧不产生空思考段）
          if (row.reasoning) {
            message.reasoning = row.reasoning;
          }
          return message;
        }
      );
    },

    listCompacts(taskId) {
      return (listCompactsStmt.all(taskId) as unknown as CompactRow[]).map(
        (row) => ({
          id: row.id,
          taskId: row.task_id,
          summary: row.summary,
          messagesCompacted: row.messages_compacted,
          createdAt: row.created_at,
        })
      );
    },

    insertToolCall(call) {
      insertToolCallStmt.run(
        call.id,
        call.taskId,
        call.toolName,
        call.arguments,
        call.output,
        call.isError ? 1 : 0,
        call.reasoning || null,
        call.createdAt
      );
    },

    listToolCalls(taskId) {
      return (listToolCallsStmt.all(taskId) as unknown as ToolCallRow[]).map(
        (row) => ({
          id: row.id,
          taskId: row.task_id,
          toolName: row.tool_name,
          arguments: row.arguments,
          output: row.output,
          isError: row.is_error === 1,
          // 子代理思考全文（票 02）：空串归一为缺失（不产生空思考）
          ...(row.reasoning ? { reasoning: row.reasoning } : {}),
          createdAt: row.created_at,
        })
      );
    },

    insertApproval(taskId, commandWord) {
      insertApprovalStmt.run(taskId, commandWord, new Date().toISOString());
    },

    listApprovals(taskId) {
      const rows = listApprovalsStmt.all(taskId) as unknown as {
        command_word: string;
      }[];
      return rows.map((row) => row.command_word);
    },

    insertSubagent(record) {
      insertSubagentStmt.run(
        record.id,
        record.taskId,
        record.task,
        record.status,
        record.queuedAt,
        record.startedAt,
        record.completedAt
      );
    },

    updateSubagent(id, patch) {
      // 只更新状态机推进的列（status/startedAt/completedAt），目标不存在静默忽略
      const columns: string[] = [];
      const values: (string | number | null)[] = [];
      if (patch.status !== undefined) {
        columns.push("status = ?");
        values.push(patch.status);
      }
      if (patch.startedAt !== undefined) {
        columns.push("started_at = ?");
        values.push(patch.startedAt);
      }
      if (patch.completedAt !== undefined) {
        columns.push("completed_at = ?");
        values.push(patch.completedAt);
      }
      if (columns.length === 0) {
        return;
      }
      db.prepare(`UPDATE subagents SET ${columns.join(", ")} WHERE id = ?`).run(
        ...values,
        id
      );
    },

    listSubagents(taskId) {
      return (listSubagentsStmt.all(taskId) as unknown as SubagentRow[]).map(
        (row) => ({
          id: row.id,
          taskId: row.task_id,
          task: row.task,
          status: row.status as SubagentRecord["status"],
          queuedAt: row.queued_at,
          startedAt: row.started_at,
          completedAt: row.completed_at,
        })
      );
    },

    insertSubagentMessage(record) {
      insertSubagentMessageStmt.run(
        record.id,
        record.taskId,
        record.subagentId,
        record.content,
        record.reasoning || null,
        record.createdAt
      );
    },

    listSubagentMessages(taskId) {
      return (
        listSubagentMessagesStmt.all(taskId) as unknown as SubagentMessageRow[]
      ).map((row) => ({
        id: row.id,
        taskId: row.task_id,
        subagentId: row.subagent_id,
        content: row.content,
        // 空串归一为缺失（与 messages.reasoning 口径一致，不产生空思考段）
        ...(row.reasoning ? { reasoning: row.reasoning } : {}),
        createdAt: row.created_at,
      }));
    },

    insertSubagentToolCall(record) {
      insertSubagentToolCallStmt.run(
        record.id,
        record.taskId,
        record.subagentId,
        record.toolName,
        record.arguments,
        record.output,
        record.isError ? 1 : 0,
        record.createdAt
      );
    },

    listSubagentToolCalls(taskId) {
      return (
        listSubagentToolCallsStmt.all(
          taskId
        ) as unknown as SubagentToolCallRow[]
      ).map((row) => ({
        id: row.id,
        taskId: row.task_id,
        subagentId: row.subagent_id,
        toolName: row.tool_name,
        arguments: row.arguments,
        output: row.output,
        isError: row.is_error === 1,
        createdAt: row.created_at,
      }));
    },

    insertTerminalSession(record) {
      insertTerminalSessionStmt.run(
        record.sessionId,
        record.taskId,
        record.name,
        record.origin,
        record.shell,
        record.status,
        record.createdAt,
        record.exitedAt ?? null,
        record.exitCode ?? null,
        record.signal ?? null,
        record.title ?? null,
        record.titleSource ?? null,
        record.snapshot ?? null
      );
    },

    updateTerminalSession(id, patch) {
      // 只更新状态机推进的列（status/exitedAt/exitCode/signal/snapshot），
      // 目标不存在静默忽略（与 updateSubagent 同语义）
      const columns: string[] = [];
      const values: (string | number | null)[] = [];
      if (patch.status !== undefined) {
        columns.push("status = ?");
        values.push(patch.status);
      }
      if (patch.exitedAt !== undefined) {
        columns.push("exited_at = ?");
        values.push(patch.exitedAt);
      }
      if (patch.exitCode !== undefined) {
        columns.push("exit_code = ?");
        values.push(patch.exitCode);
      }
      if (patch.signal !== undefined) {
        columns.push("signal = ?");
        values.push(patch.signal);
      }
      if (patch.snapshot !== undefined) {
        columns.push("snapshot = ?");
        values.push(patch.snapshot);
      }
      if (patch.title !== undefined) {
        columns.push("title = ?");
        values.push(patch.title);
      }
      if (patch.titleSource !== undefined) {
        columns.push("title_source = ?");
        values.push(patch.titleSource);
      }
      if (columns.length === 0) {
        return;
      }
      db.prepare(
        `UPDATE terminal_sessions SET ${columns.join(", ")} WHERE id = ?`
      ).run(...values, id);
    },

    terminalSession(sessionId) {
      const row = db
        .prepare("SELECT * FROM terminal_sessions WHERE id = ?")
        .get(sessionId) as TerminalSessionRow | undefined;
      return row === undefined ? null : terminalRecordOf(row);
    },

    listTerminalSessions(taskId) {
      return (
        listTerminalSessionsStmt.all(taskId) as unknown as TerminalSessionRow[]
      ).map(terminalRecordOf);
    },

    settleRunningTerminalSessions(settledAt) {
      // 只碰残留 running 行；已终态行不改写（重开幂等）
      db.prepare(
        "UPDATE terminal_sessions SET status = 'exited', exited_at = ? WHERE status = 'running'"
      ).run(settledAt);
    },

    insertGoal(record) {
      insertGoalStmt.run(
        record.id,
        record.taskId,
        record.text,
        record.status,
        record.activeMs,
        record.activeSince,
        record.createdAt,
        record.updatedAt,
        record.idleStreak,
        record.failureStreak,
        record.budgetTokens,
        record.baselineTokens
      );
    },

    listGoals(taskId) {
      return (listGoalsStmt.all(taskId) as unknown as GoalRow[]).map((row) => ({
        id: row.id,
        taskId: row.task_id,
        text: row.text,
        // 读侧容忍：非法/缺失值（如降级打开新版本库）恢复为已暂停——不自动续跑的保守口径
        status: (GOAL_STATUSES as readonly string[]).includes(row.status)
          ? (row.status as GoalRecord["status"])
          : "paused",
        activeMs: row.active_ms ?? 0,
        activeSince: row.active_since ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        idleStreak: row.idle_streak ?? 0,
        failureStreak: row.failure_streak ?? 0,
        // 未设预算（NULL）= 不限；基线旧行缺列时读回列默认值 0
        budgetTokens: row.budget_tokens ?? null,
        baselineTokens: row.baseline_tokens ?? 0,
      }));
    },

    updateGoal(id, patch) {
      // 只更新状态机推进与编辑触碰的列，目标不存在静默忽略（与 updateSubagent 同语义）
      const columns: string[] = [];
      const values: (string | number | null)[] = [];
      if (patch.status !== undefined) {
        columns.push("status = ?");
        values.push(patch.status);
      }
      if (patch.text !== undefined) {
        columns.push("text = ?");
        values.push(patch.text);
      }
      if (patch.activeMs !== undefined) {
        columns.push("active_ms = ?");
        values.push(patch.activeMs);
      }
      if (patch.activeSince !== undefined) {
        columns.push("active_since = ?");
        values.push(patch.activeSince);
      }
      if (patch.idleStreak !== undefined) {
        columns.push("idle_streak = ?");
        values.push(patch.idleStreak);
      }
      if (patch.failureStreak !== undefined) {
        columns.push("failure_streak = ?");
        values.push(patch.failureStreak);
      }
      if (patch.budgetTokens !== undefined) {
        columns.push("budget_tokens = ?");
        values.push(patch.budgetTokens);
      }
      if (patch.updatedAt !== undefined) {
        columns.push("updated_at = ?");
        values.push(patch.updatedAt);
      }
      if (columns.length === 0) {
        return;
      }
      db.prepare(`UPDATE goals SET ${columns.join(", ")} WHERE id = ?`).run(
        ...values,
        id
      );
    },

    deleteGoal(id) {
      db.prepare("DELETE FROM goals WHERE id = ?").run(id);
    },

    insertGoalVerification(record) {
      insertGoalVerificationStmt.run(
        record.id,
        record.taskId,
        record.goalId,
        record.round,
        record.passed ? 1 : 0,
        record.reason,
        record.nextAction,
        record.createdAt,
        record.outcome,
        record.toolActivity ? 1 : 0
      );
    },

    listGoalVerifications(taskId) {
      return (
        listGoalVerificationsStmt.all(
          taskId
        ) as unknown as GoalVerificationRow[]
      ).map((row) => ({
        id: row.id,
        taskId: row.task_id,
        goalId: row.goal_id,
        round: Number(row.round),
        passed: row.passed === 1,
        reason: row.reason,
        nextAction: row.next_action,
        createdAt: row.created_at,
        outcome: verificationOutcomeOf(row),
        toolActivity: row.tool_activity === 1,
      }));
    },

    close() {
      db.close();
    },
  };
}
