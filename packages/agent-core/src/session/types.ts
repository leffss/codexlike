/**
 * 会话域类型（见 GLOSSARY.md「会话」「工作区」「工具注册表」）。
 * 全部可 JSON 序列化：SessionEvent 经 Electron IPC 转发到渲染进程，
 * StoredMessage / SessionRecord / ToolCallRecord 是持久化与 IPC 共用的形状。
 */
import type { ToolCallRecord } from '../tools/types';

/** 会话运行状态：`idle` 空闲可发消息；`streaming` 模型回复流式进行中 */
export type SessionStatus = 'idle' | 'streaming';

/** 会话记录（sessions 表一行；重启恢复的数据来源） */
export interface SessionRecord {
  id: string;
  /** 侧栏显示名，默认取工作区目录名 */
  title: string;
  /** 绑定的工作区目录，agent 的文件与终端操作都被限制在其中 */
  workspacePath: string;
  /** 最近一次发送消息所用的 Provider Profile（模型选择器「对下一条生效」的落点） */
  providerProfileId: string | null;
  /** 最近一次发送消息所用的模型标识 */
  model: string | null;
  status: SessionStatus;
  /** 归档时间（ISO 8601）；null = 未归档。归档的会话不在侧栏默认列表显示（/archive） */
  archivedAt: string | null;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601；listSessions 按此倒序 */
  updatedAt: string;
}

/** 消息角色：用户消息 / 助手回复 / 错误提示（模型 API 出错的中文提示，不进入对话上下文） */
export type MessageRole = 'user' | 'assistant' | 'error';

/** 消息记录（messages 表一行） */
export interface StoredMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  /** 用户原文 / 助手回复全文 / 错误提示；@引用 内容不混入（单独存 mentions） */
  content: string;
  /**
   * 该条 user 消息携带的 @引用（GLOSSARY「@ Mention」）。
   * 持久化它，重启恢复时才能把附件内容重组进模型上下文（快照等价性，工单 06）；
   * 非 user 消息与无引用的 user 消息为 undefined。
   */
  mentions?: MentionAttachment[];
  /** 助手回复被用户中断：content 为已生成的部分文本（UI 中断点标记恢复用） */
  aborted?: boolean;
  /** ISO 8601 */
  createdAt: string;
}

/** 会话时间线条目：消息与工具调用按发生顺序合并（UI 消息流渲染与重启恢复用） */
export type TranscriptItem =
  | { kind: 'message'; message: StoredMessage }
  | { kind: 'tool-call'; call: ToolCallRecord };

/**
 * @文件引用（GLOSSARY「@ Mention」）：随消息附加的工作区文件。
 * 内容由宿主读取注入（主进程校验路径在工作区内）；消息流与持久化保持用户原文。
 */
export interface MentionAttachment {
  /** 相对工作区的路径（输入框中 @token 的原样文本） */
  path: string;
  content: string;
}

/**
 * 会话事件流：agent-core 聚合的流式事件，desktop 主进程按会话 ID 多路复用转发给渲染进程。
 * 一次 sendMessage 的事件序列（正常路径）：
 * `user-message → assistant-start → assistant-delta* → assistant-done`
 */
export type SessionEvent =
  | { type: 'user-message'; message: StoredMessage }
  | { type: 'assistant-start'; messageId: string }
  | { type: 'assistant-delta'; messageId: string; delta: string }
  | { type: 'assistant-done'; message: StoredMessage }
  /** 用户中断：已生成的部分文本保留为助手消息 */
  | { type: 'assistant-aborted'; message: StoredMessage }
  /** 模型 API 出错：中文提示落为 error 消息，会话可继续使用 */
  | { type: 'error'; message: StoredMessage }
  /**
   * 模型发起了工具调用（执行开始前；output 为空串，UI 卡片显示运行中）。
   * 审批拦截（工单 04）将发生在本事件与 tool-result 之间。
   */
  | { type: 'tool-call'; call: ToolCallRecord }
  /** 工具执行完成：call.output 已填（截断后）、isError 标记失败；记录同时落库 */
  | { type: 'tool-result'; call: ToolCallRecord };
