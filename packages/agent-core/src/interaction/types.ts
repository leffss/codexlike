/** 用户交互的跨进程契约：审批与问答共用生命周期，业务响应保持各自语义。 */
export type InteractionSource =
  { kind: "main" } | { kind: "subagent"; subagentId: string; task: string };

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface InteractiveQuestion {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

interface InteractionRequestBase {
  id: string;
  taskId: string;
  /** 发起本轮执行的用户消息标识，不因中途问答而产生新轮次。 */
  turnId: string;
  toolCallId: string;
  source: InteractionSource;
  createdAt: string;
}

export interface ApprovalInteractionRequest extends InteractionRequestBase {
  kind: "approval";
  toolName: string;
  command: string;
  commandWord: string;
}

export interface QuestionsInteractionRequest extends InteractionRequestBase {
  kind: "questions";
  questions: InteractiveQuestion[];
}

export type InteractionRequest =
  ApprovalInteractionRequest | QuestionsInteractionRequest;

export interface QuestionAnswer {
  questionId: string;
  status: "answered" | "skipped";
  selectedOptionIds: string[];
  text: string;
}

export type InteractionResponse =
  | { kind: "approval"; decision: "approve"; scope?: "once" | "task" }
  | { kind: "approval"; decision: "reject"; scope?: never }
  | { kind: "questions"; answers: QuestionAnswer[] };

export interface InteractionRecord {
  request: InteractionRequest;
  status: "pending" | "resolved" | "cancelled";
  response: InteractionResponse | null;
  resolvedAt: string | null;
  cancelReason: string | null;
}

/** 已提交问答的可读快照，随触发它的消息保存，供后续对话与压缩使用。 */
export interface QuestionAnswerSnapshot {
  interactionId: string;
  source: InteractionSource;
  answers: {
    questionId: string;
    question: string;
    status: "answered" | "skipped";
    selectedOptions: string[];
    text: string;
  }[];
}
