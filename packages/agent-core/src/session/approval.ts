/**
 * 审批域类型与状态机（GLOSSARY「审批模式」；ADR 0004 完全访问档放开工作区边界）。
 * 三档预设：
 * - `ask` 请求批准：写入、终端命令、联网搜索一律暂停等待用户审批（只读工具放行）；
 * - `assist` 帮我批准：工作区内写入与联网自动放行，终端命令仅危险黑名单命中时审批；
 * - `full-access` 完全访问：全自动，且放开工作区文件边界（可读写本地任意文件）。
 * autoApprove 是独立实时会话授权，仅跳过执行审批，不放宽文件边界，也不替答问答。
 * 遗留命令首词授权不再使用；兼容入口 always 仍仅批准一次（会话授权需显式 scope: session）。
 * 本文件浏览器安全（无 Node 内置模块），UI 与主进程共用类型。
 */
import type { ToolPermission } from "../tools/types";

/** 审批模式（会话级权限档位，可随时切换、对下一次发送生效，当前轮冻结） */
export type ApprovalMode = "ask" | "assist" | "full-access";

/** 全部档位值（IPC 校验、UI 选项、持久化白名单共用；顺序 = 严格 → 宽松） */
export const APPROVAL_MODES = ["ask", "assist", "full-access"] as const;

/** 档位中文名（UI 展示：请求批准 / 帮我批准 / 完全访问） */
export const APPROVAL_MODE_NAMES: Record<ApprovalMode, string> = {
  ask: "请求批准",
  assist: "帮我批准",
  "full-access": "完全访问",
};

/**
 * 旧库 approval_mode 值 → 新档位（持久化读侧迁移，不回写数据）：
 * readonly（旧只读，一律拒绝）→ ask（询问后可做的最严档）；suggest（旧协作）→ assist；full → full-access。
 */
export const LEGACY_APPROVAL_MODE_MAP: Record<string, ApprovalMode> = {
  readonly: "ask",
  suggest: "assist",
  full: "full-access",
};

/** 审批卡片三键对应的决定（always 在新语义下仅放行本次，不写记忆） */
export type ApprovalDecision = "approve" | "reject" | "always";

/** 审批请求（等待用户决定时经事件流推给 UI；一次审批对应一次工具调用） */
export interface ApprovalRequest {
  /** 审批 id（即对应的 tool call id；子代理的审批为独立生成的 id） */
  id: string;
  sessionId: string;
  toolName: string;
  /** 命令原文（run_terminal_command 的 command 参数；其它命令类工具为工具名） */
  command: string;
  /** 命令首词（小写归一；展示与风险判定用） */
  commandWord: string;
  /** ISO 8601 */
  createdAt: string;
  /** 由子代理发起的审批（工单 13）：审批卡片据此标注来源；主会话审批缺省 */
  subagentId?: string;
}

/** 审批门决定：放行执行 / 拒绝 / 暂停等待审批 */
export type ApprovalGate =
  | { kind: "auto" }
  | { kind: "blocked"; reason: string }
  | { kind: "ask"; commandWord: string };

/** 命令首词提取（小写归一，Windows 命令大小写不敏感） */
export function commandFirstWord(command: string): string {
  const trimmed = command.trim();
  if (trimmed === "") {
    return "";
  }
  return trimmed.split(/\s+/)[0]!.toLowerCase();
}

/**
 * 危险命令首词黑名单（assist 档「帮我批准」的风险判定）：
 * 删除 / 格式化 / 磁盘 / 提权 / 关机类首词，命中即弹审批。
 */
const RISKY_FIRST_WORDS = new Set([
  // 文件与目录删除（Unix / Windows）
  "rm",
  "del",
  "erase",
  "rmdir",
  "rd",
  // 磁盘与文件系统（不可逆破坏）
  "format",
  "diskpart",
  "dd",
  "mkfs",
  "mkfs.ext4",
  "fdisk",
  "parted",
  // 提权与系统
  "sudo",
  "shutdown",
  "reboot",
  "poweroff",
  "halt",
]);

/**
 * 危险命令模式（对整条命令小写匹配，补首词黑名单覆盖不到的组合）：
 * 强推 / 硬重置 / 清理未跟踪文件 / 发布包 / 下载即执行 / 注册表删除 / PowerShell 删除。
 */
const RISKY_PATTERNS: readonly RegExp[] = [
  /\bgit\s+push\b[^\n|;&]*\s(--force(?!-with-lease)|-f)(?=\s|$)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bnpm\s+publish\b/,
  /\b(curl|wget)\b[^|;\n]*\|\s*(ba|z|da)?sh\b/,
  /\breg\s+delete\b/,
  /\bremove-item\b/,
];

/**
 * 危险命令判定（assist 档）：首词黑名单或危险模式命中即视为风险操作，弹审批。
 * Windows 命令大小写不敏感；空串（命令类工具未提供命令参数）不视为风险。
 */
export function isRiskyCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (normalized === "") {
    return false;
  }
  const first = commandFirstWord(normalized);
  if (RISKY_FIRST_WORDS.has(first)) {
    return true;
  }
  return RISKY_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * 审批状态机（纯函数）：给定模式与工具权限类别，决定本次工具调用的门。
 * - readonly 工具（read_file/glob/grep）任何模式下放行；
 * - 未开启 autoApprove 时，ask 对 write / network / command 暂停等待审批；
 * - assist 帮我批准：write（工作区内写入）与 network（联网搜索）自动放行；
 *   command 仅 isRiskyCommand 命中时弹审批，其余自动放行；
 * - full-access 完全访问：全放行（文件边界放开见 ADR 0004）。
 * 命令类工具未提供命令参数时，风险判定对空命令返回 false（按非风险自动放行）。
 */
export function decideApproval(input: {
  mode: ApprovalMode;
  /** 实时会话授权，与本轮冻结的模式分离；只跳过执行审批。 */
  autoApprove?: boolean;
  permission: ToolPermission;
  toolName: string;
  /** run_terminal_command 的 command 参数 */
  command?: string;
}): ApprovalGate {
  const { mode, permission } = input;

  if (
    input.autoApprove ||
    permission === "readonly" ||
    mode === "full-access"
  ) {
    return { kind: "auto" };
  }

  // 请求批准：写入、联网、命令一律询问
  if (mode === "ask") {
    const commandWord =
      commandFirstWord(input.command ?? "") || input.toolName.toLowerCase();
    return { kind: "ask", commandWord };
  }

  // 帮我批准：工作区内写入与联网自动放行
  if (permission === "write" || permission === "network") {
    return { kind: "auto" };
  }

  // 帮我批准 × 终端命令：仅危险黑名单命中时弹审批，其余自动放行
  if (isRiskyCommand(input.command ?? "")) {
    const commandWord =
      commandFirstWord(input.command ?? "") || input.toolName.toLowerCase();
    return { kind: "ask", commandWord };
  }
  return { kind: "auto" };
}
