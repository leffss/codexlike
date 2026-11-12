/**
 * 会话内容列宽度类（票 05「容器分档宽度」，宽度边界见 ADR 0011）：
 * 消息流、头部与输入区共用同一内容列宽度类，保证左右缘对齐（spec 用户故事 35）。
 *
 * 断点基准是会话容器（WorkspacePage 中栏的 `@container/session`）而非浏览器视口：
 * 应用侧栏开合改变容器宽度时按档位分档响应；右侧面板（规范与技能 / 改动）是
 * 容器内的兄弟节点，开合不改变容器宽度，不会触发断点切换导致内容列跳宽。
 *
 * 三档：
 * - 基础档（容器 <864px）：内容列全宽，不设上限；
 * - 容器 ≥864px：收窄留白（calc(100% - 6rem)）且上限 max-w-4xl（896px）；
 * - 容器 ≥1280px：留白加大（calc(100% - 12rem)）且上限 max-w-6xl（1152px）。
 *
 * 宽度变化不做过渡动画（避免拖拽 / 面板开合时反复触发消息测高）。
 */
export const SESSION_CONTENT_WIDTH_CLASS =
  "mx-auto w-full @min-[864px]/session:w-[calc(100%_-_6rem)] @min-[864px]/session:max-w-4xl @min-[1280px]/session:w-[calc(100%_-_12rem)] @min-[1280px]/session:max-w-6xl";

/** 空态（未选会话或消息流为空）：内容列固定 2xl（672px）档，聚焦草稿输入。 */
export const SESSION_EMPTY_WIDTH_CLASS = "mx-auto w-full max-w-2xl";
