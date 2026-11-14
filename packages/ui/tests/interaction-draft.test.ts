import { describe, expect, it } from "vitest";
import type { QuestionsInteractionRequest } from "@codexlike/agent-core";
import {
  createQuestionDraft,
  updateQuestionDraft,
  questionResponse,
} from "../src/lib/interaction-draft";

const request: QuestionsInteractionRequest = {
  id: "r1",
  taskId: "s1",
  turnId: "t1",
  toolCallId: "c1",
  kind: "questions",
  source: { kind: "main" },
  createdAt: "2026-11-11T08:00:00Z",
  questions: [
    {
      id: "q1",
      header: "方案",
      question: "选哪个方案？",
      multiSelect: false,
      options: [
        { id: "a", label: "方案 A" },
        { id: "b", label: "方案 B" },
      ],
    },
    {
      id: "q2",
      header: "能力",
      question: "需要哪些能力？",
      multiSelect: true,
      options: [
        { id: "x", label: "能力 X" },
        { id: "y", label: "能力 Y" },
      ],
    },
  ],
};

export { request as questionsRequest };

describe("问答草稿公共 interface", () => {
  it("未答不能前进；忽略清空答案并前进，回看可重新回答且最后忽略不自动提交", () => {
    let draft = createQuestionDraft(request);
    expect(updateQuestionDraft(request, draft, { type: "next" }).index).toBe(0);
    draft = updateQuestionDraft(request, draft, {
      type: "custom",
      text: "旧答案",
    });
    draft = updateQuestionDraft(request, draft, { type: "skip" });
    expect(draft.index).toBe(1);
    expect(draft.answers.q1).toEqual({
      selectedOptionIds: [],
      text: "",
      skipped: true,
    });
    draft = updateQuestionDraft(request, draft, { type: "skip" });
    expect(draft.index).toBe(1);
    expect(
      questionResponse(request, draft)?.answers.map((answer) => answer.status)
    ).toEqual(["skipped", "skipped"]);
    draft = updateQuestionDraft(request, draft, { type: "prev" });
    draft = updateQuestionDraft(request, draft, {
      type: "option",
      optionId: "a",
    });
    expect(questionResponse(request, draft)?.answers[0]).toEqual({
      questionId: "q1",
      status: "answered",
      selectedOptionIds: ["a"],
      text: "",
    });
  });
  it("单选与自定义互斥；多选可附加自定义，整组未答时不生成响应", () => {
    let draft = createQuestionDraft(request);
    expect(questionResponse(request, draft)).toBeNull();
    draft = updateQuestionDraft(request, draft, {
      type: "option",
      optionId: "a",
    });
    draft = updateQuestionDraft(request, draft, {
      type: "custom",
      text: "另一方案",
    });
    expect(draft.answers.q1).toEqual({
      selectedOptionIds: [],
      text: "另一方案",
      skipped: false,
    });
    draft = updateQuestionDraft(request, draft, {
      type: "option",
      optionId: "b",
    });
    expect(draft.answers.q1).toEqual({
      selectedOptionIds: ["b"],
      text: "",
      skipped: false,
    });
    draft = updateQuestionDraft(request, draft, { type: "next" });
    draft = updateQuestionDraft(request, draft, {
      type: "option",
      optionId: "x",
    });
    draft = updateQuestionDraft(request, draft, {
      type: "option",
      optionId: "y",
    });
    draft = updateQuestionDraft(request, draft, {
      type: "custom",
      text: "附加能力",
    });
    expect(questionResponse(request, draft)).toEqual({
      kind: "questions",
      answers: [
        {
          questionId: "q1",
          status: "answered",
          selectedOptionIds: ["b"],
          text: "",
        },
        {
          questionId: "q2",
          status: "answered",
          selectedOptionIds: ["x", "y"],
          text: "附加能力",
        },
      ],
    });
  });
});
