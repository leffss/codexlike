import type {
  InteractionRecord,
  SavedQuestionDraft,
} from "@codexlike/agent-core";

import {
  COLLAPSE_BODY_CLASS,
  COLLAPSE_CARD_CLASS,
  COLLAPSE_SUMMARY_CLASS,
} from "../lib/collapse-card";

import { DisclosureArrow } from "./DisclosureArrow";

/** 只读历史摘要：请求、响应与取消均可展开，永远没有执行按钮。 */
export function InteractionHistory({
  record,
  draft,
}: {
  record: InteractionRecord;
  draft?: SavedQuestionDraft;
}) {
  const { request, response } = record;
  const status =
    record.status === "cancelled"
      ? "已取消"
      : record.status === "pending"
        ? request.kind === "approval"
          ? "等待审批"
          : "等待回答"
        : response?.kind === "approval"
          ? record.autoApproved === true
            ? // 反馈2：任务自动批准即时放行的留痕，与用户手动授权区分
              "已自动批准"
            : response.decision === "approve"
              ? response.scope === "task"
                ? "已批准（任务授权批量通过）"
                : "已批准（本次）"
              : "已拒绝"
          : "已回答";
  return (
    <li
      data-testid="interaction-history"
      data-interaction-id={request.id}
      data-interaction-kind={request.kind}
      data-interaction-status={record.status}
      // 折叠卡外形/内距契约见 lib/collapse-card；卡片背景挂在 li 上：
      // 取消态的「已保存草稿」尾注也属于同一张卡
      className={`${COLLAPSE_CARD_CLASS} min-w-0`}
    >
      {/* 非受控开合（历史卡无需随流式状态自动收起）：箭头角度交给
          group-open 由原生 [open] 驱动，保持零状态 */}
      <details className="group">
        <summary
          className={`${COLLAPSE_SUMMARY_CLASS} focus-visible:outline-2 focus-visible:outline-accent`}
        >
          <DisclosureArrow className="group-open:rotate-90" />
          <span
            data-testid="interaction-history-summary"
            className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]"
          >
            <span
              className={
                record.status === "pending" ? "text-warn-fg" : "text-fg"
              }
            >
              {status}
            </span>
            {" · "}
            {request.kind === "approval" ? "执行审批" : "交互问答"}
            {" · "}
            {request.source.kind === "main"
              ? "主代理"
              : `子代理 · ${request.source.task}`}
          </span>
        </summary>
        <div
          data-testid="interaction-history-content"
          className={`${COLLAPSE_BODY_CLASS} max-h-80 space-y-2 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]`}
        >
          {request.kind === "approval" ? (
            /* 命令 pre 白卡呈现（bg-surface），避免与暖灰块同底色灰上加灰 */
            <pre className="whitespace-pre-wrap break-all rounded-lg bg-surface p-2 text-code-fg">
              {request.command}
            </pre>
          ) : (
            request.questions.map((question) => {
              const answer =
                response?.kind === "questions"
                  ? response.answers.find(
                      (item) => item.questionId === question.id
                    )
                  : undefined;
              return (
                <div key={question.id}>
                  <p className="font-medium text-fg">{question.question}</p>
                  <p>
                    {answer?.status === "skipped"
                      ? "已忽略"
                      : answer
                        ? [
                            ...answer.selectedOptionIds.map(
                              (id) =>
                                question.options.find(
                                  (option) => option.id === id
                                )?.label ?? id
                            ),
                            answer.text,
                          ]
                            .filter(Boolean)
                            .join("；")
                        : record.status === "pending"
                          ? "等待回答"
                          : "未提交"}
                  </p>
                </div>
              );
            })
          )}
          {record.cancelReason && <p>{record.cancelReason}</p>}
        </div>
      </details>
      {record.status === "cancelled" &&
        request.kind === "questions" &&
        draft && (
          <div
            data-testid="saved-question-draft"
            // 尾注与展开体同列（28px 左缘、12px 右缘），避免卡内出现第三档左缘
            className="mt-2 whitespace-pre-wrap break-words pb-2 pl-7 pr-3"
          >
            <p>已保存的未提交草稿（原请求已失效，仅供查看，不会继续执行）</p>
            {request.questions.map((question) => {
              const answer = draft.answers[question.id];
              return answer ? (
                <p key={question.id}>
                  {question.question}：
                  {[
                    ...answer.selectedOptionIds.map(
                      (id) =>
                        question.options.find((option) => option.id === id)
                          ?.label ?? id
                    ),
                    answer.text,
                    answer.skipped ? "已选择忽略" : "",
                  ]
                    .filter(Boolean)
                    .join("；")}
                </p>
              ) : null;
            })}
          </div>
        )}
    </li>
  );
}
