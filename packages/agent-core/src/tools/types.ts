/**
 * 工具域类型（GLOSSARY「工具注册表」）。
 * 全部可 JSON 序列化：ToolCallRecord 与会话事件、IPC、UI 卡片共用。
 * 本文件浏览器安全（无 Node 内置模块），实现（fs/child_process）在 ./node 出口。
 */
import type { ApprovalMode } from "../task/approval";
import type { ProviderProfile } from "../provider/provider-profile";
import type { ThinkingEffort } from "../provider/language-model";

/**
 * 权限类别（GLOSSARY「审批模式」三档的判定输入）：
 * - `readonly`：只读操作（read_file、glob、grep），任何审批模式下放行；
 * - `write`：工作区内写入（write_file、apply_patch）；
 * - `command`：终端命令（run_terminal_command）与其它任意副作用；
 * - `network`：联网操作（web_search）——ask 档审批，assist / full-access 放行。
 */
export type ToolPermission = "readonly" | "write" | "command" | "network";

/** 工具执行上下文：会话循环在每次调用时提供（工作区边界与会话级资源随之逐会话生效） */
export interface ToolExecutionContext {
  /** 会话绑定的工作区目录（绝对路径） */
  workspacePath: string;
  /** 当前审批模式：full-access 档文件工具放开工作区边界（ADR 0004），其余档强制边界 */
  approvalMode: ApprovalMode;
  /** 调用所属会话：会话级资源（如浏览器 context/Cookie）按它隔离复用 */
  sessionId: string;
  /** 会话中断信号：长任务应尊重（终端命令用于超时外的人工打断） */
  signal?: AbortSignal;
  /**
   * 本次 sendMessage 的 Provider Profile（工单 13）：
   * spawn_subagent 在「子代理模型 = 同主模型」时以此回退；其余工具可忽略。
   */
  profile?: ProviderProfile;
  /**
   * 本次 sendMessage 固定的思考档位快照（GLOSSARY「思考档位」，思考档位 03）：
   * 与 profile 同一通道由主会话工具执行入口转发；spawn_subagent 委派入队时
   * 以此捕获快照（排队/运行/全部工具轮次均用它），其余工具可忽略。
   */
  thinkingEffort?: ThinkingEffort;
  /**
   * 模型给定的 tool call id：spawn_subagent 委派与报告回流的绑定键（工单 13）、
   * 截图文件命名（工单 11）；测试注入固定值
   */
  toolCallId?: string;
}

/** 工具结果附带的图片（截图）：多模态端点作为 image 内容块附给模型，端点不支持时忽略 */
export interface ToolResultImage {
  /** IANA media type（如 image/png） */
  mediaType: string;
  /** 图片二进制的 base64（不含 data: 前缀） */
  data: string;
}

/** 工具执行结果：output 已截断，直接回填模型；isError 标记失败（失败原因也在 output） */
export interface ToolResult {
  output: string;
  isError: boolean;
  /** 图片附件（截图）：output 文本同时包含路径说明，降级端点仍可工作 */
  images?: ToolResultImage[];
  /**
   * 子代理思考过程全文（票 02）：spawn_subagent 延迟 tool-result 专用——
   * 编排器随最终报告回流思考文本，随工具记录落库（reasoning 列）供恢复展示；
   * 不回填模型（回填内容只有 output）。其余工具不使用。
   */
  reasoning?: string;
}

/** JSON Schema（draft-07 的 object 子集；声明为交叉类型以允许额外关键字如 additionalProperties） */
export type ToolParametersSchema = { type: "object" } & Record<string, unknown>;

/**
 * 统一工具接口：名称、JSON Schema 参数、权限类别、执行器。
 * 内置工具（本包）与 MCP 工具（工单 12）都适配为这一接口后入注册表。
 */
export interface ToolDefinition {
  /** 模型可见的工具名（snake_case） */
  name: string;
  /** 给模型的工具说明 */
  description: string;
  /** 参数 JSON Schema */
  parameters: ToolParametersSchema;
  permission: ToolPermission;
  /** 执行器：args 为模型给出的参数对象；异常由注册表包装为 isError 结果 */
  execute(args: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}

/** 工具调用记录（tool_calls 表一行；会话事件与 UI 卡片共用形状） */
export interface ToolCallRecord {
  /** 模型给定的 tool call id */
  id: string;
  sessionId: string;
  toolName: string;
  /** 参数的 JSON 字符串（UI 展示时解析） */
  arguments: string;
  /** 截断后的执行输出 */
  output: string;
  isError: boolean;
  /**
   * 子代理思考过程全文（票 02）：仅 spawn_subagent 委派记录携带
   * （子代理终态报告落库时一并写入），恢复路径据此重建子代理卡内思考折叠块；
   * 不回填模型上下文。旧数据无此列值时自然缺失。
   */
  reasoning?: string;
  /** ISO 8601 */
  createdAt: string;
}
