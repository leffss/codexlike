/**
 * 折叠卡内距契约（工具卡 ToolCallCard 为基准，2026-11-26 用户反馈收敛）：
 * 卡壳只负责外形、不挂水平内距；摘要行与展开体各自挂内距——
 * - 摘要行 px-3.5 py-[9px]（箭头左缘 14px、标题块左缘 26px）；
 * - 展开体 py-2 pl-7 pr-3（正文左缘 28px、分隔线通栏）。
 *
 * 两者必须分别落在摘要行与展开体上：把 px 挂到卡壳、pl-7 挂到展开体，
 * 会叠加成 42px；漏掉 pl-7 则正文停在 14px——2026-11-26 用户反馈的
 * 已思考/已回答卡片错位即这两类。e2e 几何断言（assertCollapseInsets）
 * 锁住 26px / 28px 两个值。
 */
export const COLLAPSE_ROW_PADDING = "px-3.5 py-[9px]";

/** 卡壳外形：只负责圆角/底色/字号，不挂任何水平内距 */
export const COLLAPSE_CARD_CLASS =
  "rounded-lg bg-surface-muted text-xs text-fg-muted";

/** 摘要行骨架：箭头 + 标题 + 尾部状态/耗时在同一行 */
export const COLLAPSE_SUMMARY_CLASS = `flex cursor-pointer select-none items-center gap-2 ${COLLAPSE_ROW_PADDING}`;

/** 展开体骨架：分隔线通栏，正文与摘要标题列同基（pl-7 = 28px） */
export const COLLAPSE_BODY_CLASS = "border-t border-line py-2 pl-7 pr-3";
