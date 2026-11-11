import type {
  InteractionRecord,
  InteractionResponse,
} from "@codexlike/agent-core";
import { useEffect, useRef, type KeyboardEvent } from "react";
import {
  answerComplete,
  questionResponse,
  type QuestionAction,
  type QuestionDraft,
} from "../lib/interaction-draft";

const actionClass =
  "rounded border border-line px-3 py-2 text-sm text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";

/** 唯一可操作用户交互区域；停止始终位于提交锁之外。 */
export function InteractionPanel(props: {
  record: InteractionRecord;
  count: number;
  draft?: QuestionDraft;
  busy: boolean;
  error: string | null;
  onChange: (action: QuestionAction) => void;
  onRespond: (response: InteractionResponse) => void;
  onStop: () => void;
}) {
  const { request } = props.record;
  const disabled = props.busy || props.record.status !== "pending";
  const question =
    request.kind === "questions" && props.draft
      ? request.questions[props.draft.index]
      : undefined;
  const answer = question && props.draft?.answers[question.id];
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [request.id, props.draft?.index]);
  function optionKey(event: KeyboardEvent<HTMLInputElement>, optionId: string) {
    if (
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      disabled
    )
      return;
    if (event.key === "Enter") {
      event.preventDefault();
      props.onChange({ type: "option", optionId });
    }
    // radio 方向键与 Space 交给浏览器；不劫持 textarea 或 Tab。
  }
  return (
    <section
      data-testid="interaction-panel"
      data-interaction-id={request.id}
      data-interaction-kind={request.kind}
      aria-label="等待用户交互"
      aria-busy={props.busy}
      className="flex max-h-[65vh] min-h-0 min-w-0 shrink-0 flex-col border-t border-line bg-surface px-4 py-3 text-fg"
    >
      <header className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span
          data-testid="interaction-source"
          className="max-h-20 min-w-0 flex-1 overflow-y-auto break-words text-fg-muted [overflow-wrap:anywhere]"
        >
          {request.source.kind === "main"
            ? "主代理"
            : `子代理 · ${request.source.task}`}
        </span>
        <span data-testid="interaction-count" className="text-warn-fg">
          待处理 {props.count} 项
        </span>
        <button
          type="button"
          data-testid="composer-stop"
          onClick={props.onStop}
          className="rounded bg-danger-solid px-3 py-1.5 text-on-accent hover:bg-danger-solid-hover focus-visible:outline-2 focus-visible:outline-accent"
        >
          停止
        </button>
      </header>
      <div className="min-h-0 overflow-y-auto overscroll-contain break-words [overflow-wrap:anywhere]">
        {request.kind === "approval" && (
          <>
            <h2 className="text-sm font-medium">
              执行审批 · {request.toolName}
            </h2>
            <pre className="my-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-code-bg p-3 font-mono text-xs text-code-fg">
              {request.command}
            </pre>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="approval-approve"
                disabled={disabled}
                className={`${actionClass} bg-ok-bg text-ok-fg`}
                onClick={() =>
                  props.onRespond({ kind: "approval", decision: "approve" })
                }
              >
                批准本次
              </button>
              <button
                type="button"
                data-testid="approval-reject"
                disabled={disabled}
                className={`${actionClass} bg-danger-bg text-danger-fg`}
                onClick={() =>
                  props.onRespond({ kind: "approval", decision: "reject" })
                }
              >
                拒绝
              </button>
            </div>
          </>
        )}
        {request.kind === "questions" && props.draft && question && answer && (
          <>
            <p
              data-testid="question-progress"
              aria-live="polite"
              className="mb-1 text-xs text-fg-muted"
            >
              第 {props.draft.index + 1} / {request.questions.length} 题 ·{" "}
              {question.header}
            </p>
            <h2
              ref={heading}
              tabIndex={-1}
              data-testid="question-title"
              id="interaction-question-title"
              className="mb-2 whitespace-pre-wrap text-sm font-medium focus:outline-none"
            >
              {question.question}
            </h2>
            <p className="mb-2 text-xs text-fg-muted">
              {question.multiSelect
                ? "可多选，也可补充自定义回答"
                : "单选，或填写自定义回答"}
              {answer.skipped ? " · 已忽略，可重新回答" : ""}
            </p>
            <fieldset
              disabled={disabled}
              aria-labelledby="interaction-question-title"
              className="min-w-0 space-y-2"
            >
              {question.options.map((option, index) => (
                <label
                  key={option.id}
                  className={`flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm ${answer.selectedOptionIds.includes(option.id) ? "border-accent bg-selected" : "border-line hover:bg-hover"}`}
                >
                  <input
                    data-testid={`question-option-${option.id}`}
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={`question-${request.id}-${question.id}`}
                    checked={answer.selectedOptionIds.includes(option.id)}
                    aria-describedby={
                      option.description
                        ? `question-description-${index}`
                        : undefined
                    }
                    onChange={() =>
                      props.onChange({ type: "option", optionId: option.id })
                    }
                    onKeyDown={(event) => optionKey(event, option.id)}
                    className="mt-0.5 shrink-0 accent-accent focus-visible:outline-2 focus-visible:outline-accent"
                  />
                  <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                    <span className="block">{option.label}</span>
                    {option.description && (
                      <span
                        id={`question-description-${index}`}
                        className="mt-1 block text-xs text-fg-muted"
                      >
                        {option.description}
                      </span>
                    )}
                  </span>
                </label>
              ))}
              <label className="block text-xs text-fg-muted">
                自定义回答
                <textarea
                  data-testid="question-custom"
                  value={answer.text}
                  rows={2}
                  onChange={(event) =>
                    props.onChange({ type: "custom", text: event.target.value })
                  }
                  placeholder="输入你的回答（不会按 Enter 提交）"
                  className="mt-1 block max-h-40 w-full resize-y rounded border border-line bg-surface-muted p-2 text-sm text-fg focus:border-accent focus:outline-none"
                />
              </label>
            </fieldset>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="question-prev"
                disabled={disabled || props.draft.index === 0}
                className={actionClass}
                onClick={() => props.onChange({ type: "prev" })}
              >
                上一题
              </button>
              <button
                type="button"
                data-testid="question-skip"
                disabled={disabled}
                className={actionClass}
                onClick={() => props.onChange({ type: "skip" })}
              >
                忽略
              </button>
              {props.draft.index < request.questions.length - 1 ? (
                <button
                  type="button"
                  data-testid="question-next"
                  disabled={disabled || !answerComplete(answer)}
                  className={`${actionClass} ml-auto`}
                  onClick={() => props.onChange({ type: "next" })}
                >
                  继续
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="question-submit"
                  disabled={
                    disabled || questionResponse(request, props.draft) === null
                  }
                  className={`${actionClass} ml-auto bg-accent text-on-accent`}
                  onClick={() => {
                    const response = questionResponse(request, props.draft!);
                    if (response && !disabled) props.onRespond(response);
                  }}
                >
                  {props.busy ? "提交中…" : "提交整组"}
                </button>
              )}
            </div>
          </>
        )}
        {props.error && (
          <p
            data-testid="interaction-error"
            role="alert"
            className="mt-2 whitespace-pre-wrap text-sm text-danger-fg"
          >
            {props.error}
          </p>
        )}
        {props.record.status !== "pending" && (
          <p className="mt-2 text-xs text-fg-muted">
            该交互已结束，不能重复回答
          </p>
        )}
      </div>
    </section>
  );
}
