/**
 * 折叠卡内距契约（工具卡 ToolCallCard 为基准，2026-11-26 用户反馈收敛）：
 * 卡壳只负责外形、不挂水平内距；摘要行与展开体各自挂内距——
 * - 摘要行 px-3.5 py-[9px]（箭头左缘 14px、标题文字左缘 26px；带内距的
 *   工具名徽章用等量 -ml 抵消，文字与纯文本标题同列）；
 * - 展开体 py-2 pl-7 pr-3（正文左缘 28px、分隔线通栏）。
 *
 * 两者必须分别落在摘要行与展开体上：把 px 挂到卡壳、pl-7 挂到展开体，
 * 会叠加成 42px；漏掉 pl-7 则正文停在 14px——2026-11-26 用户反馈的
 * 已思考/已回答卡片错位即这两类。e2e 几何断言（assertCollapseInsets）
 * 按标题「文字」左缘锁 26px、展开体正文左缘锁 28px。
 */
export const COLLAPSE_ROW_PADDING = "px-3.5 py-[9px]";

/** 卡壳外形：只负责圆角/底色/字号，不挂任何水平内距 */
export const COLLAPSE_CARD_CLASS =
  "rounded-lg bg-surface-muted text-xs text-fg-muted";

/** 摘要行骨架：箭头 + 标题 + 尾部状态/耗时在同一行 */
export const COLLAPSE_SUMMARY_CLASS = `flex cursor-pointer select-none items-center gap-2 ${COLLAPSE_ROW_PADDING}`;

/** 展开体骨架：分隔线通栏，正文与摘要标题列同基（pl-7 = 28px） */
export const COLLAPSE_BODY_CLASS = "border-t border-line py-2 pl-7 pr-3";

/**
 * 摘要标题徽章（工具名等机器域标识）：左内距用等量负 margin 抵消，
 * 让徽章「文字」与纯文本标题同落 26px。盒左缘 26px + px 会把文字推到
 * 32px——2026-11-27 apply_patch 卡片标题比「已思考」多缩进即此。
 */
export const COLLAPSE_TITLE_BADGE_CLASS =
  "-ml-1 rounded bg-code-bg px-1 py-0.5 font-mono text-xs text-accent";
