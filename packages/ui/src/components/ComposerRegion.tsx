import type { ReactNode } from "react";

import { TASK_CONTENT_WIDTH_CLASS } from "../lib/content-width";

/**
 * 中栏底部输入区外壳（2026-11-19 交互面板整合轮）：消息输入框与交互面板
 * （权限批准 / 交互式提问）共用的同一插槽外壳——两者在 WorkspacePage 互斥
 * 渲染，此前交互面板直接全宽撑满中栏；收拢此前壳层后，宽度（背景画布、
 * px-4 水平内边距、滚动槽右缘补偿、contentWidthClass 居中收窄）与输入框
 * 完全一致，视觉上就是输入框区域变成了问题区域。
 *
 * 上下内边距 pt-2.5 / pb-4（原型 D 定案 10px / 16px）：输入区外壳放宽
 * 上下呼吸（ADR 0028），底部留出比顶部更大的下距。
 *
 * 内层沿用 @container：composer 工具栏窄宽降级以内容列实际宽度为基准
 * （右栏开合不改变 @container/task 宽度，ADR 0011），交互面板暂无断点
 * 但与输入框共用同一基准，后续加断点直接可用。
 */
export function ComposerRegion(props: {
  /** e2e / 单测定位：composer 用 composer-region，交互面板用 interaction-region */
  testId: string;
  /** 内容列宽度类：与消息流、头部共用同一基准列（WorkspacePage 单点下发） */
  contentWidthClass?: string;
  children: ReactNode;
}) {
  const contentWidthClass = props.contentWidthClass ?? TASK_CONTENT_WIDTH_CLASS;
  return (
    // 补偿消息流原生滚动条占宽，基准列对齐。正文列左右同宽（2026-11-26
    // 用户反馈「正文与输入框左右离卡片边框不一样」）：消息流左缘已补槽宽，
    // 本壳左右都按「基准 1rem + 槽」留白，输入卡本体再在列内左右各外扩 12px。
    <div
      data-testid={props.testId}
      className="bg-canvas px-4 pt-2.5 pb-4"
      style={{
        paddingLeft: "calc(1rem + var(--task-scrollbar-gutter, 0px))",
        paddingRight: "calc(1rem + var(--task-scrollbar-gutter, 0px))",
      }}
    >
      <div className={`${contentWidthClass} @container`}>{props.children}</div>
    </div>
  );
}
