import type { ApprovalMode } from "@codexlike/agent-core";

/**
 * composer 系图标（新建任务居中起点式票 01 抽共享）：
 * 从 MessageComposer 原样移出——正式任务 composer 与新建起点页的输入卡
 * 共用同一组图标（发送上箭头同款、审批/思考选择器配图一致），只做代码
 * 移动，不改任何绘制。
 */

export function ApprovalModeIcon(props: {
  mode: ApprovalMode;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={props.className}
      aria-hidden="true"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {props.mode === "full-access" ? (
        <>
          <path d="M6 7V4a3 3 0 0 1 6 0" />
          <rect x="3" y="7" width="10" height="7" rx="1.5" />
          <path d="M8 10v1" />
        </>
      ) : (
        <>
          <path d="M8 1.5 13 3.4V7c0 3.1-2.1 5.8-5 6.9C5.1 12.8 3 10.1 3 7V3.4L8 1.5Z" />
          {props.mode === "ask" ? (
            <>
              <path d="M6.5 6a1.5 1.5 0 0 1 3 0c0 1-1.5 1-1.5 2" />
              <circle
                cx="8"
                cy="10.5"
                r="0.75"
                fill="currentColor"
                stroke="none"
              />
            </>
          ) : (
            <path d="m5.5 7.5 1.5 1.5 3.5-3.5" />
          )}
        </>
      )}
    </svg>
  );
}

export function BrainIcon(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={props.className}
      aria-hidden="true"
    >
      <path
        d="M6 2.5a2 2 0 0 0-2 2c-1.1.2-2 1.1-2 2.3 0 .8.4 1.5 1 1.9v.6c0 1.7 1.3 3.2 3 3.2h1V2.5H6ZM10 2.5a2 2 0 0 1 2 2c1.1.2 2 1.1 2 2.3 0 .8-.4 1.5-1 1.9v.6c0 1.7-1.3 3.2-3 3.2H9V2.5h1Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ArrowUpIcon(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={props.className}
      aria-hidden="true"
    >
      <path
        d="M8 13V3.5M3.8 7.7 8 3.5l4.2 4.2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
