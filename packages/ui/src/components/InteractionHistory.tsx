import type { InteractionRecord } from "@codexlike/agent-core";

/** 只读历史摘要：请求、响应与取消均可展开，永远没有执行按钮。 */
export function InteractionHistory({ record }: { record: InteractionRecord }) {
  const { request, response } = record;
  const status =
    record.status === "cancelled"
      ? "已取消"
      : record.status === "pending"
        ? request.kind === "approval"
          ? "等待审批"
          : "等待回答"
        : response?.kind === "approval"
          ? response.decision === "approve"
            ? "已批准"
            : "已拒绝"
          : "已回答";
  return (
    <li
      data-testid="interaction-history"
      data-interaction-id={request.id}
      data-interaction-kind={request.kind}
      data-interaction-status={record.status}
      className="min-w-0 rounded-lg border border-line bg-surface-muted p-3 text-xs text-fg-muted"
    >
      <details>
        <summary className="cursor-pointer break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-accent">
          <span
            className={record.status === "pending" ? "text-warn-fg" : "text-fg"}
          >
            {status}
          </span>
          {" · "}
          {request.kind === "approval" ? "执行审批" : "交互问答"}
          {" · "}
          {request.source.kind === "main"
            ? "主代理"
            : `子代理 · ${request.source.task}`}
        </summary>
        <div className="mt-2 max-h-80 space-y-2 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {request.kind === "approval" ? (
            <pre className="whitespace-pre-wrap break-all rounded bg-code-bg p-2 text-code-fg">
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
    </li>
  );
}
