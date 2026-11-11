import type { ApprovalDecision } from '@codexlike/agent-core';

import type { UiApproval } from '../lib/session-view';

/** 审批决定 → 中文文案（结果态徽标） */
const DECISION_LABELS: Record<ApprovalDecision, string> = {
  approve: '已批准',
  reject: '已拒绝',
  always: '已总是允许',
};

/**
 * 审批卡片（spec 用户故事 13）：suggest 模式下终端命令暂停等待审批。
 * 三键：批准（本次执行）/ 拒绝（原因回填模型）/ 本会话总是允许（按命令首词记忆）。
 * 响应后转为结果态；等待期间命令不会执行。
 */
export function ApprovalCard(props: {
  approval: UiApproval;
  onRespond: (id: string, decision: ApprovalDecision) => void;
}) {
  const { approval } = props;
  const decision = approval.decision;
  const waiting = decision === null;

  return (
    <li
      data-testid="approval-card"
      data-approval-command={approval.command}
      className={`rounded-lg border px-3 py-2 text-sm ${
        waiting
          ? 'border-warn-fg/40 bg-warn-bg'
          : 'border-line bg-surface'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="rounded bg-warn-bg px-1.5 py-0.5 text-xs text-warn-fg">
          等待审批
        </span>
        <span className="text-fg-muted">agent 请求执行终端命令：</span>
      </div>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-code-bg p-2 font-mono text-xs text-code-fg">
        {approval.command}
      </pre>
      {waiting ? (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            data-testid="approval-approve"
            className="rounded bg-ok-solid px-3 py-1.5 text-xs text-on-accent hover:bg-ok-solid-hover"
            onClick={() => props.onRespond(approval.id, 'approve')}
          >
            批准
          </button>
          <button
            type="button"
            data-testid="approval-reject"
            className="rounded bg-danger-solid px-3 py-1.5 text-xs text-on-accent hover:bg-danger-solid-hover"
            onClick={() => props.onRespond(approval.id, 'reject')}
          >
            拒绝
          </button>
          <button
            type="button"
            data-testid="approval-always"
            className="rounded bg-accent px-3 py-1.5 text-xs text-on-accent hover:bg-accent-hover"
            title={`本会话内首词为 ${approval.commandWord} 的命令不再询问`}
            onClick={() => props.onRespond(approval.id, 'always')}
          >
            本会话总是允许
          </button>
          <span className="ml-auto text-xs text-fg-subtle">
            命令首词：<code className="text-fg-muted">{approval.commandWord}</code>
          </span>
        </div>
      ) : (
        <p className="mt-2 text-xs text-fg-muted">
          {DECISION_LABELS[decision]}
          {decision === 'always' && (
            <span className="text-fg-subtle">
              （本会话内首词为 {approval.commandWord} 的命令不再询问）
            </span>
          )}
        </p>
      )}
    </li>
  );
}
