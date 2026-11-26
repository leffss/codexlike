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
  /**
   * 【原型设施，prototype/card-shell】外壳附加类：整页卡片变体用它给输入区
   * 加顶部发丝线、或做成舱内悬浮托盘；缺省不改变任何现状样式。
   */
  className?: string;
  children: ReactNode;
}) {
  const contentWidthClass = props.contentWidthClass ?? TASK_CONTENT_WIDTH_CLASS;
  // 无附加类时保持与既有 DOM 完全一致的 class 串（测试按此断言）
  const surfaceClass =
    props.className === undefined
      ? "bg-canvas px-4 pt-2.5 pb-4"
      : `bg-canvas px-4 pt-2.5 pb-4 ${props.className}`;
  return (
    // 补偿消息流原生滚动条占宽，基准列对齐（2026-11-19 起输入卡本体在
    // 列内再左右各外扩 12px，比正文列宽一点；见 MessageComposer 输入卡）。
    <div
      data-testid={props.testId}
      className={surfaceClass}
      style={{
        paddingRight: "calc(1rem + var(--task-scrollbar-gutter, 0px))",
      }}
    >
      <div className={`${contentWidthClass} @container`}>{props.children}</div>
    </div>
  );
}
