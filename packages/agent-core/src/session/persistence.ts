import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ToolCallRecord } from "../tools/types";
import type {
  InteractionRecord,
  QuestionAnswerSnapshot,
} from "../interaction/types";
import { LEGACY_APPROVAL_MODE_MAP } from "./approval";
import { createSessionSearch, type SessionSearchResult } from "./search";
import { workbenchKey } from "./workbench-state";
import type {
  CompactRecord,
  ProjectRecord,
  SessionRecord,
  StoredMessage,
} from "./types";

/**
 * 会话持久化接口（spec「会话与持久化」节）。
 * 以接口注入：生产环境用 SQLite 文件库（`~/.codexlike/`），
 * 测试可换内存库或内存实现（ADR-0002：agent-core 可用 Node 内置 API，不依赖 Electron）。
 *
 * compact（工单 08）与审批记忆（工单 04）均已落地，各自在此接口上扩展方法。
 */
export interface SessionPersistence {
  readWorkbench(key: string): import("./workbench-state").WorkbenchEntry | null;
  writeWorkbench(
    key: string,
    entry: import("./workbench-state").WorkbenchEntry
  ): boolean;
  insertProject(record: ProjectRecord): void;
  listProjects(): ProjectRecord[];
  /** 单事务删除显式所属会话及关联记录；返回准确影响集合，不访问文件系统。 */
  removeProject(projectId: string): string[];
  isRemovedCreationRequest(requestId: string): boolean;
  setProjectCollapsed(projectId: string, collapsed: boolean): void;
  insertSession(record: SessionRecord): void;
  /** 仅回滚尚未写入首条消息的创建；不会删除文件或已有历史。 */
  removeUnstartedSession(id: string): void;
  /** 只更新给定字段；目标不存在时静默忽略（写入方持有内存态，读路径不经过这里） */
  updateSession(
    id: string,
    patch: Partial<Omit<SessionRecord, "id" | "createdAt">>
  ): void;
  insertMessage(message: StoredMessage): void;
  insertInteraction(interaction: InteractionRecord): void;
  listInteractions(sessionId: string): InteractionRecord[];
  /** pending → 终态；问答快照与终态在同一事务提交，重复提交返回 false。 */
  settleInteraction(
    interaction: InteractionRecord,
    snapshot?: QuestionAnswerSnapshot
  ): boolean;
  /**
   * /compact 落地（工单 08）：单事务内把会话消息历史整体替换（摘要 + 保留轮次），
   * 并追加 compact 记录；pruneToolCallsBefore 同时清理该会话中更早的工具调用记录
   * （被压缩轮次的工具卡片随历史一起折叠进摘要）。事务保证压缩结果原子可见——
   * 旧历史要么完整保留、要么完整被替换。
   */
  replaceHistory(
    sessionId: string,
    messages: StoredMessage[],
    compact: CompactRecord,
    pruneToolCallsBefore?: string
  ): void;
  /** 全部会话，置顶优先、用户最近使用倒序；后台更新不重排。 */
  listSessions(): SessionRecord[];
  searchSessions(
    query: string,
    includeArchived?: boolean
  ): SessionSearchResult[];
  /** 指定会话的全部消息，按写入顺序；未知会话返回空数组 */
  listMessages(sessionId: string): StoredMessage[];
  /** 指定会话的 compact 记录，按时间正序（最后一条为当前生效摘要） */
  listCompacts(sessionId: string): CompactRecord[];
  /** 工具调用记录（一次调用完成时写入一条完整记录） */
  insertToolCall(call: ToolCallRecord): void;
  /** 指定会话的工具调用记录，按写入顺序 */
  listToolCalls(sessionId: string): ToolCallRecord[];
  /** 「本会话总是允许」记忆（命令首词；重复写入幂等） */
  insertApproval(sessionId: string, commandWord: string): void;
  /** 指定会话的「总是允许」记忆（命令首词集合；恢复会话时读回） */
  listApprovals(sessionId: string): string[];
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
CREATE TABLE IF NOT EXISTS sessions (
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
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  mentions TEXT,
  aborted INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_session_created
  ON messages(session_id, created_at);
CREATE TABLE IF NOT EXISTS compact_records (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  messages_compacted INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  arguments TEXT NOT NULL,
  output TEXT NOT NULL,
  is_error INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session_created
  ON tool_calls(session_id, created_at);
CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  record TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interactions_session ON interactions(session_id, created_at);
CREATE TABLE IF NOT EXISTS approvals (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  command_word TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, command_word)
);
`;

interface SessionRow {
  id: string;
  project_id: string | null;
  creation_request_id: string | null;
  title: string;
  workspace_path: string;
  provider_profile_id: string | null;
  model: string | null;
  status: string;
  approval_mode: string;
  workspace_mode: string;
  workspace_origin_path: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  pinned: number;
  last_used_at: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
  mentions: string | null;
  aborted: number | null;
  question_answers: string | null;
}

interface CompactRow {
  id: string;
  session_id: string;
  summary: string;
  messages_compacted: number;
  created_at: string;
}

interface ToolCallRow {
  id: string;
  session_id: string;
  tool_name: string;
  arguments: string;
  output: string;
  is_error: number;
  created_at: string;
}

/**
 * 基于 node:sqlite（Node 22.13+ / Electron 45 内置，无原生编译依赖）的会话存储。
 * 单条语句写入即单个事务（SQLite 语义），断电安全。
 * 测试传 `:memory:` 得到内存库。
 */
export function createSqliteSessionStore(dbPath: string): SessionPersistence {
  // 父目录不存在时自建（SQLite 不会创建目录）：打包后首次启动 ~/.codexlike
  // 尚未建立，宿主也未统一 mkdir，这里不自建则 whenReady 链在第一步即断
  // （2026-11-11 打包黑屏事故）。`:memory:` 时 dirname 为 "."，mkdir 空操作。
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  // 旧库迁移：工单 02 时代的 sessions 表没有 archived_at（工单 07）、
  // 工单 03 时代没有 approval_mode（工单 04 审批三档）
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN archived_at TEXT");
  } catch {
    // 列已存在（新库或已迁移）
  }
  try {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'assist'"
    );
  } catch {
    // 列已存在（新库或已迁移）
  }
  // 旧库迁移：工单 08 时代的 sessions 表没有 workspace_mode（工单 09 托管 Worktree）
  try {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'local'"
    );
  } catch {
    // 列已存在（新库或已迁移）
  }
  // 旧库迁移：ADR 0005（项目侧栏按原始仓库聚合）之前的表没有 workspace_origin_path
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN workspace_origin_path TEXT");
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

  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all();
  if (!sessionColumns.some((column) => column.name === "project_id"))
    db.exec(
      "ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id)"
    );
  if (!sessionColumns.some((column) => column.name === "creation_request_id"))
    db.exec("ALTER TABLE sessions ADD COLUMN creation_request_id TEXT");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_creation_request ON sessions(creation_request_id)"
  );
  const projectColumns = db.prepare("PRAGMA table_info(projects)").all();
  if (!projectColumns.some((column) => column.name === "collapsed"))
    db.exec(
      "ALTER TABLE projects ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0"
    );
  if (!sessionColumns.some((column) => column.name === "pinned"))
    db.exec(
      "ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"
    );
  if (!sessionColumns.some((column) => column.name === "last_used_at"))
    db.exec("ALTER TABLE sessions ADD COLUMN last_used_at TEXT");
  const insertSession = db.prepare(
    "INSERT INTO sessions (id, title, workspace_path, provider_profile_id, model, status, approval_mode, workspace_mode, workspace_origin_path, archived_at, created_at, updated_at, project_id, creation_request_id, pinned, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const updateSessionStmt = db.prepare(
    "UPDATE sessions SET title = ?, workspace_path = ?, provider_profile_id = ?, model = ?, status = ?, approval_mode = ?, workspace_mode = ?, workspace_origin_path = ?, archived_at = ?, updated_at = ?, pinned = ?, last_used_at = ?, project_id = ? WHERE id = ?"
  );
  const insertMessageStmt = db.prepare(
    "INSERT INTO messages (id, session_id, role, content, created_at, mentions, aborted, question_answers) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const listSessionsStmt = db.prepare(
    "SELECT * FROM sessions ORDER BY pinned DESC, COALESCE(last_used_at, created_at) DESC, created_at DESC, id DESC"
  );
  const listMessagesStmt = db.prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid"
  );
  const deleteMessagesStmt = db.prepare(
    "DELETE FROM messages WHERE session_id = ?"
  );
  const deleteToolCallsBeforeStmt = db.prepare(
    "DELETE FROM tool_calls WHERE session_id = ? AND created_at < ?"
  );
  const insertCompactStmt = db.prepare(
    "INSERT INTO compact_records (id, session_id, summary, messages_compacted, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  const listCompactsStmt = db.prepare(
    "SELECT * FROM compact_records WHERE session_id = ? ORDER BY created_at, rowid"
  );
  const insertToolCallStmt = db.prepare(
    "INSERT INTO tool_calls (id, session_id, tool_name, arguments, output, is_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const listToolCallsStmt = db.prepare(
    "SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at, rowid"
  );
  const insertApprovalStmt = db.prepare(
    "INSERT OR IGNORE INTO approvals (session_id, command_word, created_at) VALUES (?, ?, ?)"
  );
  const listApprovalsStmt = db.prepare(
    "SELECT command_word FROM approvals WHERE session_id = ? ORDER BY created_at, rowid"
  );

  function toRecord(row: SessionRow): SessionRecord {
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
          : (row.status as SessionRecord["status"]),
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
      // 原始仓库路径（ADR 0005）：旧库 / local 会话 / 旧 worktree 会话均为 null
      workspaceOriginPath: row.workspace_origin_path ?? null,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      pinned: row.pinned === 1,
      lastUsedAt: row.last_used_at ?? row.created_at,
    };
  }

  /** 写入一条消息（含 @引用 与中断标记列；insertMessage 与 replaceHistory 共用） */
  function insertMessage(message: StoredMessage): void {
    insertMessageStmt.run(
      message.id,
      message.sessionId,
      message.role,
      message.content,
      message.createdAt,
      message.mentions === undefined || message.mentions.length === 0
        ? null
        : JSON.stringify(message.mentions),
      message.aborted === true ? 1 : 0,
      message.questionAnswers?.length
        ? JSON.stringify(message.questionAnswers)
        : null
    );
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
    searchSessions: createSessionSearch(db),
    insertProject(record) {
      db.prepare(
        "INSERT INTO projects (id, name, workspace_path, created_at) VALUES (?, ?, ?, ?)"
      ).run(record.id, record.name, record.workspacePath, record.createdAt);
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
          .prepare("SELECT id FROM sessions WHERE project_id = ?")
          .all(projectId);
        const deleteWorkbench = db.prepare(
          "DELETE FROM workbench_state WHERE key = ?"
        );
        deleteWorkbench.run(workbenchKey({ kind: "new", projectId }));
        for (const member of members)
          deleteWorkbench.run(
            workbenchKey({ kind: "session", sessionId: String(member.id) })
          );
        // 成功创建意图保留墓碑，避免移入后移除的独立草稿因重试重建会话。
        db.prepare(
          "INSERT OR IGNORE INTO removed_creation_requests SELECT creation_request_id FROM sessions WHERE project_id = ? AND creation_request_id IS NOT NULL"
        ).run(projectId);
        // 显式关联清理，不依赖各运行时 foreign_keys 默认值，不按目录推导集合。
        for (const table of [
          "messages",
          "compact_records",
          "tool_calls",
          "interactions",
          "approvals",
        ]) {
          db.prepare(
            `DELETE FROM ${table} WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)`
          ).run(projectId);
        }
        db.prepare("DELETE FROM sessions WHERE project_id = ?").run(projectId);
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
    listProjects() {
      return db
        .prepare("SELECT * FROM projects ORDER BY created_at, rowid")
        .all()
        .map((row) => ({
          id: String(row.id),
          name: String(row.name),
          workspacePath: String(row.workspace_path),
          collapsed: row.collapsed === 1,
          createdAt: String(row.created_at),
        }));
    },
    insertSession(record) {
      insertSession.run(
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
        record.lastUsedAt ?? record.createdAt
      );
    },
    removeUnstartedSession(id) {
      db.prepare(
        "DELETE FROM sessions WHERE id = ? AND NOT EXISTS (SELECT 1 FROM messages WHERE session_id = ?)"
      ).run(id, id);
    },

    updateSession(id, patch) {
      const current = db
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .get(id) as SessionRow | undefined;
      if (current === undefined) {
        return;
      }
      const next = { ...toRecord(current), ...patch };
      updateSessionStmt.run(
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
        id
      );
    },

    insertMessage(message) {
      insertMessage(message);
    },

    insertInteraction(interaction) {
      db.prepare(
        "INSERT INTO interactions (id, session_id, record, created_at) VALUES (?, ?, ?, ?)"
      ).run(
        interaction.request.id,
        interaction.request.sessionId,
        JSON.stringify(interaction),
        interaction.request.createdAt
      );
    },

    listInteractions(sessionId) {
      return db
        .prepare(
          "SELECT record FROM interactions WHERE session_id = ? ORDER BY created_at, rowid"
        )
        .all(sessionId)
        .map((row) => JSON.parse(String(row.record)) as InteractionRecord);
    },

    settleInteraction(interaction, snapshot) {
      db.exec("BEGIN");
      try {
        const row = db
          .prepare(
            "SELECT record FROM interactions WHERE id = ? AND session_id = ?"
          )
          .get(interaction.request.id, interaction.request.sessionId);
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
              "SELECT question_answers FROM messages WHERE id = ? AND session_id = ? AND role = 'user'"
            )
            .get(interaction.request.turnId, interaction.request.sessionId);
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

    replaceHistory(sessionId, messages, compact, pruneToolCallsBefore) {
      // 单事务：删除旧消息 + 写入新历史（摘要 + 保留轮次）+ 追加 compact 记录
      // + 清理被压缩轮次的工具调用记录，原子落地（中途失败整体回滚，旧历史不受损）。
      // 重写消息复用 insertMessage（含 mentions / aborted 列）：
      // 保留轮次携带的 @引用 与中断标记在 compact 重写后不丢（恢复等价性，工单 06）
      db.exec("BEGIN");
      try {
        deleteMessagesStmt.run(sessionId);
        for (const message of messages) {
          insertMessage(message);
        }
        insertCompactStmt.run(
          compact.id,
          compact.sessionId,
          compact.summary,
          compact.messagesCompacted,
          compact.createdAt
        );
        if (pruneToolCallsBefore !== undefined) {
          deleteToolCallsBeforeStmt.run(sessionId, pruneToolCallsBefore);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    listSessions() {
      return (listSessionsStmt.all() as unknown as SessionRow[]).map(toRecord);
    },

    listMessages(sessionId) {
      return (listMessagesStmt.all(sessionId) as unknown as MessageRow[]).map(
        (row) => {
          const message: StoredMessage = {
            id: row.id,
            sessionId: row.session_id,
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
          return message;
        }
      );
    },

    listCompacts(sessionId) {
      return (listCompactsStmt.all(sessionId) as unknown as CompactRow[]).map(
        (row) => ({
          id: row.id,
          sessionId: row.session_id,
          summary: row.summary,
          messagesCompacted: row.messages_compacted,
          createdAt: row.created_at,
        })
      );
    },

    insertToolCall(call) {
      insertToolCallStmt.run(
        call.id,
        call.sessionId,
        call.toolName,
        call.arguments,
        call.output,
        call.isError ? 1 : 0,
        call.createdAt
      );
    },

    listToolCalls(sessionId) {
      return (listToolCallsStmt.all(sessionId) as unknown as ToolCallRow[]).map(
        (row) => ({
          id: row.id,
          sessionId: row.session_id,
          toolName: row.tool_name,
          arguments: row.arguments,
          output: row.output,
          isError: row.is_error === 1,
          createdAt: row.created_at,
        })
      );
    },

    insertApproval(sessionId, commandWord) {
      insertApprovalStmt.run(sessionId, commandWord, new Date().toISOString());
    },

    listApprovals(sessionId) {
      const rows = listApprovalsStmt.all(sessionId) as unknown as {
        command_word: string;
      }[];
      return rows.map((row) => row.command_word);
    },

    close() {
      db.close();
    },
  };
}
