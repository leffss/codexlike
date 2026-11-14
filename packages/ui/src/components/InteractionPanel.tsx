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

/**
 * 每题选项数上限：与 agent-core 侧 ask_user_question 工具 schema /
 * parseQuestions 的 0–8 契约一致；渲染层再裁一次，防住绕过工具解析的
 * 数据来源（历史恢复等）把面板撑出滚动语义。
 */
const MAX_QUESTION_OPTIONS = 8;

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
      className="flex max-h-[65vh] min-h-0 min-w-0 flex-col border-t border-line bg-surface px-4 py-3 text-fg"
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col break-words [overflow-wrap:anywhere]">
        {request.kind === "approval" && (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
                data-testid="approval-approve-task"
                disabled={disabled}
                aria-describedby="task-approval-warning"
                className={`${actionClass} bg-warn-bg text-warn-fg`}
                onClick={() =>
                  props.onRespond({
                    kind: "approval",
                    decision: "approve",
                    scope: "task",
                  })
                }
              >
                批准本任务后续所有请求
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
            <p id="task-approval-warning" className="mt-2 text-xs text-warn-fg">
              将批量批准本任务主代理与子代理当前排队及后续执行审批，危险命令也会自动执行。重启后保留，直到手动取消；不代答问答、不影响其他任务，不切换完全访问或放宽文件工具边界。
            </p>
          </div>
        )}
        {request.kind === "questions" && props.draft && question && answer && (
          <>
            {/* 反馈4：滚动只作用于选项列表——问题说明与自定义回答、按钮固定显示 */}
            <p
              data-testid="question-progress"
              aria-live="polite"
              className="mb-1 shrink-0 text-xs text-fg-muted"
            >
              第 {props.draft.index + 1} / {request.questions.length} 题 ·{" "}
              {question.header}
            </p>
            <h2
              ref={heading}
              tabIndex={-1}
              data-testid="question-title"
              id="interaction-question-title"
              className="mb-2 shrink-0 whitespace-pre-wrap text-sm font-medium focus:outline-none"
            >
              {question.question}
            </h2>
            <p className="mb-2 shrink-0 text-xs text-fg-muted">
              {question.multiSelect
                ? "可多选，也可补充自定义回答"
                : "单选，或填写自定义回答"}
              {answer.skipped ? " · 已忽略，可重新回答" : ""}
            </p>
            <fieldset
              disabled={disabled}
              aria-labelledby="interaction-question-title"
              className="contents"
            >
              {/* 滚动容器必须是纯 div：Chromium 对 fieldset 盒模型有渲染怪癖，
                  flex item 的尺寸约束与 overflow 滚动不生效（选项会溢出面板、
                  与下方固定区重叠）；fieldset 仅承载禁用语义（display:contents
                  不生成盒），布局由穿透后的 div 直接参与外层 flex 列。 */}
              <div
                data-testid="question-options"
                role="group"
                aria-labelledby="interaction-question-title"
                className="min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto overscroll-contain"
              >
                {question.options
                  .slice(0, MAX_QUESTION_OPTIONS)
                  .map((option, index) => (
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
                          props.onChange({
                            type: "option",
                            optionId: option.id,
                          })
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
              </div>
              <label className="mt-2 block shrink-0 text-xs text-fg-muted">
                自定义回答
                <textarea
                  data-testid="question-custom"
                  value={answer.text}
                  rows={2}
                  onChange={(event) =>
                    props.onChange({ type: "custom", text: event.target.value })
                  }
                  placeholder="输入你的回答（不会按 Enter 提交）"
                  className="mt-1 block max-h-40 w-full resize-y rounded border border-line bg-surface-muted p-2 text-sm text-fg focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                />
              </label>
              <div className="mt-3 flex shrink-0 flex-wrap gap-2">
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
                  // 反馈5：accent 底按钮不复用 actionClass（其 hover:bg-hover 会盖掉
                  // accent 底色致浅底白字不可见），hover 用 accent-hover
                  <button
                    type="button"
                    data-testid="question-submit"
                    disabled={
                      disabled ||
                      questionResponse(request, props.draft) === null
                    }
                    className="ml-auto rounded border border-line px-3 py-2 text-sm text-on-accent bg-accent hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => {
                      const response = questionResponse(request, props.draft!);
                      if (response && !disabled) props.onRespond(response);
                    }}
                  >
                    {props.busy ? "提交中…" : "提交"}
                  </button>
                )}
              </div>
            </fieldset>
          </>
        )}
        {props.error && (
          <p
            data-testid="interaction-error"
            role="alert"
            className="mt-2 shrink-0 whitespace-pre-wrap text-sm text-danger-fg"
          >
            {props.error}
          </p>
        )}
        {props.record.status !== "pending" && (
          <p className="mt-2 shrink-0 text-xs text-fg-muted">
            该交互已结束，不能重复回答
          </p>
        )}
      </div>
    </section>
  );
}
