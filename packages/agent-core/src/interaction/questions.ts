import type { ToolDefinition } from "../tools/types";
import type {
  InteractionRecord,
  InteractionRequest,
  InteractionResponse,
  InteractiveQuestion,
  QuestionAnswerSnapshot,
} from "./types";

export const ASK_USER_QUESTION = "ask_user_question";
/** 字符数上限（按 JS 字符串长度）：标识 64、标题 80、正文 2000、标签 200、说明 1000、回答 8000。 */
const limits = {
  id: 64,
  header: 80,
  question: 2000,
  label: 200,
  description: 1000,
  text: 8000,
};
function object(
  value: unknown,
  keys: string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label}必须是对象`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)))
    throw new Error(`${label}包含未知字段`);
  return result;
}
function text(
  value: unknown,
  max: number,
  label: string,
  empty = false
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim())
  )
    throw new Error(
      `${label}必须是${empty ? "" : "非空"}字符串，最多 ${max} 个字符`
    );
  return value;
}
function array(
  value: unknown,
  min: number,
  max: number,
  label: string
): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new Error(`${label}必须包含 ${min}–${max} 项`);
  return value;
}
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length)
    throw new Error(`${label}不能重复`);
}
export function parseQuestions(input: unknown): InteractiveQuestion[] {
  const args = object(input, ["questions"], "问答参数");
  const questions = array(args.questions, 1, 8, "问题").map((value) => {
    const q = object(
      value,
      ["id", "header", "question", "multiSelect", "options"],
      "问题"
    );
    if (typeof q.multiSelect !== "boolean")
      throw new Error("multiSelect 必须是布尔值");
    const options = array(q.options, 0, 8, "选项").map((value) => {
      const option = object(value, ["id", "label", "description"], "选项");
      return {
        id: text(option.id, limits.id, "选项 ID"),
        label: text(option.label, limits.label, "选项标签"),
        ...(option.description === undefined
          ? {}
          : {
              description: text(
                option.description,
                limits.description,
                "选项说明",
                true
              ),
            }),
      };
    });
    unique(
      options.map((option) => option.id),
      "选项 ID"
    );
    return {
      id: text(q.id, limits.id, "问题 ID"),
      header: text(q.header, limits.header, "问题标题"),
      question: text(q.question, limits.question, "问题正文"),
      multiSelect: q.multiSelect,
      options,
    };
  });
  unique(
    questions.map((q) => q.id),
    "问题 ID"
  );
  return questions;
}
export function parseInteractionResponse(
  request: InteractionRequest,
  input: unknown
): InteractionResponse {
  const response = object(
    input,
    request.kind === "approval"
      ? ["kind", "decision", "scope"]
      : ["kind", "answers"],
    "交互响应"
  );
  if (response.kind !== request.kind)
    throw new Error("交互响应类型与请求不匹配");
  if (request.kind === "approval") {
    if (response.decision !== "approve" && response.decision !== "reject")
      throw new Error("审批决定必须是 approve 或 reject");
    if (response.decision === "reject") {
      if (Object.hasOwn(response, "scope"))
        throw new Error("拒绝审批不能指定 scope");
      return { kind: "approval", decision: "reject" };
    }
    if (
      Object.hasOwn(response, "scope") &&
      response.scope !== "once" &&
      response.scope !== "task"
    )
      throw new Error("审批 scope 必须是 once 或 task");
    return {
      kind: "approval",
      decision: "approve",
      ...(response.scope === undefined
        ? {}
        : { scope: response.scope as "once" | "task" }),
    };
  }
  const answers = array(
    response.answers,
    request.questions.length,
    request.questions.length,
    "回答"
  ).map((value) => {
    const a = object(
      value,
      ["questionId", "status", "selectedOptionIds", "text"],
      "回答"
    );
    const questionId = text(a.questionId, limits.id, "回答问题 ID");
    const question = request.questions.find((q) => q.id === questionId);
    if (!question) throw new Error("回答引用了未知问题 ID");
    if (a.status !== "answered" && a.status !== "skipped")
      throw new Error("回答状态必须是 answered 或 skipped");
    const selectedOptionIds = array(a.selectedOptionIds, 0, 8, "已选选项").map(
      (id) => text(id, limits.id, "选项 ID")
    );
    unique(selectedOptionIds, "已选选项 ID");
    if (
      selectedOptionIds.some(
        (id) => !question.options.some((option) => option.id === id)
      )
    )
      throw new Error("回答引用了未知选项 ID");
    if (!question.multiSelect && selectedOptionIds.length > 1)
      throw new Error("单选问题不能选择多个选项");
    const answerText = text(a.text, limits.text, "自定义回答", true);
    if (
      !question.multiSelect &&
      selectedOptionIds.length > 0 &&
      answerText !== ""
    )
      throw new Error("单选问题的预设选项与自定义回答不能同时提交");
    if (
      a.status === "skipped" &&
      (selectedOptionIds.length || answerText !== "")
    )
      throw new Error("跳过的问题不能包含选项或文本");
    if (
      a.status === "answered" &&
      !selectedOptionIds.length &&
      !answerText.trim()
    )
      throw new Error("已回答的问题必须选择选项或输入文本");
    return {
      questionId,
      status: a.status as "answered" | "skipped",
      selectedOptionIds,
      text: answerText,
    };
  });
  unique(
    answers.map((a) => a.questionId),
    "回答问题 ID"
  );
  return { kind: "questions", answers };
}
export function questionSnapshot(
  request: InteractionRequest,
  response: InteractionResponse
): QuestionAnswerSnapshot | undefined {
  if (request.kind !== "questions" || response.kind !== "questions")
    return undefined;
  return {
    interactionId: request.id,
    source: request.source,
    answers: request.questions.map((question) => {
      const answer = response.answers.find(
        (a) => a.questionId === question.id
      )!;
      return {
        questionId: question.id,
        question: question.question,
        status: answer.status,
        selectedOptions: answer.selectedOptionIds.map(
          (id) => question.options.find((option) => option.id === id)!.label
        ),
        text: answer.text,
      };
    }),
  };
}
export function createQuestionsTool(
  request: (
    questions: InteractiveQuestion[],
    toolCallId: string
  ) => Promise<InteractionRecord>
): ToolDefinition {
  const string = (maxLength: number) => ({
    type: "string",
    minLength: 1,
    maxLength,
  });
  return {
    name: ASK_USER_QUESTION,
    description:
      "向用户提出 1–8 个澄清问题并等待回答。每题 0–8 个选项；空选项表示纯文本。用户可自定义回答或跳过；任何审批档位都不会自动回答。ID 最多64字符，标题80，正文2000，标签200，说明1000。",
    permission: "readonly",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["questions"],
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "header", "question", "multiSelect", "options"],
            properties: {
              id: string(limits.id),
              header: string(limits.header),
              question: string(limits.question),
              multiSelect: { type: "boolean" },
              options: {
                type: "array",
                minItems: 0,
                maxItems: 8,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "label"],
                  properties: {
                    id: string(limits.id),
                    label: string(limits.label),
                    description: {
                      type: "string",
                      maxLength: limits.description,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async execute(input, context) {
      const result = await request(
        parseQuestions(input),
        context.toolCallId ?? ""
      );
      return result.status === "resolved"
        ? { output: JSON.stringify(result.response), isError: false }
        : {
            output: `用户问答已取消：${result.cancelReason ?? "本轮已结束"}`,
            isError: true,
          };
    },
  };
}
