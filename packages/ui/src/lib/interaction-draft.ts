import type {
  InteractiveQuestion,
  InteractionResponse,
  QuestionsInteractionRequest,
} from "@codexlike/agent-core";

export interface AnswerDraft {
  selectedOptionIds: string[];
  text: string;
  skipped: boolean;
}

export interface QuestionDraft {
  index: number;
  answers: Record<string, AnswerDraft>;
}

export type QuestionAction =
  | { type: "option"; optionId: string }
  | { type: "custom"; text: string }
  | { type: "next" }
  | { type: "prev" }
  | { type: "skip" };

export function createQuestionDraft(
  request: QuestionsInteractionRequest
): QuestionDraft {
  return {
    index: 0,
    answers: Object.fromEntries(
      request.questions.map((question) => [
        question.id,
        {
          selectedOptionIds: [],
          text: "",
          skipped: false,
        },
      ])
    ),
  };
}

export function answerComplete(answer: AnswerDraft | undefined): boolean {
  return (
    answer !== undefined &&
    (answer.skipped ||
      answer.selectedOptionIds.length > 0 ||
      answer.text.trim() !== "")
  );
}

export function updateQuestionDraft(
  request: QuestionsInteractionRequest,
  draft: QuestionDraft,
  action: QuestionAction
): QuestionDraft {
  const question = request.questions[draft.index];
  if (!question) return draft;
  const answer = draft.answers[question.id]!;
  if (action.type === "prev")
    return { ...draft, index: Math.max(0, draft.index - 1) };
  if (action.type === "skip")
    return {
      index: Math.min(draft.index + 1, request.questions.length - 1),
      answers: {
        ...draft.answers,
        [question.id]: { selectedOptionIds: [], text: "", skipped: true },
      },
    };
  if (action.type === "next") {
    return answerComplete(answer)
      ? {
          ...draft,
          index: Math.min(draft.index + 1, request.questions.length - 1),
        }
      : draft;
  }
  let next: AnswerDraft;
  if (action.type === "custom") {
    next = {
      selectedOptionIds: question.multiSelect ? answer.selectedOptionIds : [],
      text: action.text,
      skipped: false,
    };
  } else {
    if (!question.options.some((option) => option.id === action.optionId))
      return draft;
    next = {
      selectedOptionIds: question.multiSelect
        ? answer.selectedOptionIds.includes(action.optionId)
          ? answer.selectedOptionIds.filter((id) => id !== action.optionId)
          : [...answer.selectedOptionIds, action.optionId]
        : [action.optionId],
      text: question.multiSelect ? answer.text : "",
      skipped: false,
    };
  }
  return { ...draft, answers: { ...draft.answers, [question.id]: next } };
}

/** 只有整组完整（含明确忽略）才产生可提交的跨进程响应。 */
export function questionResponse(
  request: QuestionsInteractionRequest,
  draft: QuestionDraft
): Extract<InteractionResponse, { kind: "questions" }> | null {
  if (
    request.questions.length === 0 ||
    !request.questions.every((question) =>
      answerComplete(draft.answers[question.id])
    )
  )
    return null;
  return {
    kind: "questions",
    answers: request.questions.map((question: InteractiveQuestion) => {
      const answer = draft.answers[question.id]!;
      return {
        questionId: question.id,
        status: answer.skipped ? "skipped" : "answered",
        selectedOptionIds: answer.selectedOptionIds,
        text: answer.text,
      };
    }),
  };
}
