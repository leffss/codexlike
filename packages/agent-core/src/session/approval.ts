/**
 * 审批域类型与状态机（GLOSSARY「审批模式」；spec「Implementation Decisions → 审批模式」）。
 * 三档为 Codex 两轴（sandbox × approval）的预设组合：
 * - `readonly` ≈ read-only：写入与命令一律拒绝；
 * - `suggest` ≈ workspace-write + 命令审批：文件编辑自动应用，终端命令逐条审批；
 * - `full` ≈ danger-full-access + never：全自动。
 * 本文件浏览器安全（无 Node 内置模块），UI 与主进程共用类型。
 */
import type { ToolPermission } from '../tools/types';

/** 审批模式（会话级权限档位，可随时切换、对下一次工具调用立即生效） */
export type ApprovalMode = 'readonly' | 'suggest' | 'full';

/** 审批卡片三键对应的决定 */
export type ApprovalDecision = 'approve' | 'reject' | 'always';

/** 审批请求（等待用户决定时经事件流推给 UI；一次审批对应一次工具调用） */
export interface ApprovalRequest {
  /** 审批 id（即对应的 tool call id；子代理的审批为独立生成的 id） */
  id: string;
  sessionId: string;
  toolName: string;
  /** 命令原文（run_terminal_command 的 command 参数；其它命令类工具为工具名） */
  command: string;
  /** 命令首词（小写归一；「本会话总是允许」的记忆键） */
  commandWord: string;
  /** ISO 8601 */
  createdAt: string;
  /** 由子代理发起的审批（工单 13）：审批卡片据此标注来源；主会话审批缺省 */
  subagentId?: string;
}

/** 审批门决定：放行执行 / 拒绝 / 暂停等待审批 */
export type ApprovalGate =
  | { kind: 'auto' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'ask'; commandWord: string };

/** 命令首词提取（审批记忆键；大小写归一，Windows 命令大小写不敏感） */
export function commandFirstWord(command: string): string {
  const trimmed = command.trim();
  if (trimmed === '') {
    return '';
  }
  return trimmed.split(/\s+/)[0]!.toLowerCase();
}

/**
 * 审批状态机（纯函数）：给定模式、工具权限类别与「总是允许」记忆，决定本次工具调用的门。
 * - readonly 工具（read_file/glob/grep）任何模式下放行；
 * - readonly 模式：write/command 拒绝，拒绝原因返回模型（模型可改用只读工具）；
 * - suggest 模式：write 放行（diff 可审阅可撤销）；command 记忆命中放行、否则暂停等待审批；
 * - full 模式：全放行。
 * 记忆键 = 命令首词（小写）；命令类工具未提供命令参数时回退为工具名（MCP 命令类工具按名记忆）。
 */
export function decideApproval(input: {
  mode: ApprovalMode;
  permission: ToolPermission;
  /** 工具名（命令参数缺省时的记忆键回退） */
  toolName: string;
  /** run_terminal_command 的 command 参数 */
  command?: string;
  memory: ReadonlySet<string>;
}): ApprovalGate {
  const { mode, permission, memory } = input;

  if (permission === 'readonly' || mode === 'full') {
    return { kind: 'auto' };
  }

  if (mode === 'readonly') {
    return {
      kind: 'blocked',
      reason:
        permission === 'write'
          ? '当前会话为 readonly（只读）审批模式，禁止写入文件。请改用只读工具（read_file/glob/grep）完成任务，或提示用户切换审批模式。'
          : '当前会话为 readonly（只读）审批模式，禁止执行终端命令。请改用只读工具（read_file/glob/grep）完成任务，或提示用户切换审批模式。',
    };
  }

  // suggest：文件编辑自动应用；命令逐条审批（记忆命中除外）
  if (permission === 'write') {
    return { kind: 'auto' };
  }
  const commandWord = commandFirstWord(input.command ?? '') || input.toolName.toLowerCase();
  if (memory.has(commandWord)) {
    return { kind: 'auto' };
  }
  return { kind: 'ask', commandWord };
}
