import type { ITheme } from "@xterm/xterm";

/**
 * 终端主题适配（票 04：语义 token → xterm palette 一处收口）：
 * 语义 token（ADR 0006/0028）没有 xterm 的 16 色 ANSI 槽位，本文件是
 * CSS 变量 → palette 的唯一换算点——TerminalSessionView 不得自拼色值。
 *
 * 映射策略：基础面（背景/前景/光标/选区）直接取语义 token，主题翻转
 * 自动跟随；ANSI 16 色借用既有的语义色 token（危险红 / 成功绿 / 警告黄
 * / 信息蓝 / 工作区紫 / 子代理青），不做独立配色——终端输出的着色语义
 * （diff 红绿、警告黄）与语义 token 的语义一致，且随 data-theme 翻转。
 * bright 系列与基础系列同色（VS Code 默认主题同款做法），仅 brightBlack
 * 用最弱前景（注释灰）与 brightWhite 用前景主色区分两端。
 *
 * 选区基色契约（2026-11-22「选中全黑」修复）：selectionBackground 必须带
 * α（8 位 hex，前景墨 @ 0.3）。xterm 6 的主题解析把带 α 的选区色 blend 成
 * 压平洗染（selectionBackgroundOpaque = blend(背景, 选区色@原α)），行工厂
 * 再把洗染色以 inline background-color 画进选中格 span、字形之下（焦点态
 * 与失焦态同构），字形保持原色可读；给不透明色时 blend 对 α=1 原样返回
 * 纯墨——纯墨直接画成单元格背景，墨底墨字整块全黑。xterm 自身默认选区色
 * 同为 rgba α=0.3（VS Code 同款惯例），此契约是回到库的设计正路。
 * 另：.xterm-selection overlay 层（z-index 1 压字形上方、色值恒为不透明
 * 洗染）由 styles.css display:none 隐藏——它是旧渲染机制的残留层，span 级
 * 绘制已是唯一选区渲染源，留着只会盖字。改选区观感改 --terminal-selection，
 * 不改此处。
 */

/** xterm palette 消费的语义色值表（全部为 CSS 变量名，读取时求值） */
const PALETTE_TOKENS = {
  background: "--canvas",
  foreground: "--fg",
  cursor: "--fg",
  cursorAccent: "--canvas",
  selectionBackground: "--terminal-selection",
  black: "--accent",
  red: "--danger-fg",
  green: "--ok-fg",
  yellow: "--warn-fg",
  blue: "--info-fg",
  magenta: "--worktree-fg",
  cyan: "--subagent-fg",
  white: "--fg-muted",
  brightBlack: "--fg-subtle",
} as const;

const BRIGHT_SAME_KEYS = [
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;

/**
 * 语义 token 值表 → xterm palette（纯函数：测试用字面量期望独立验证
 * 映射，不依赖 CSS 环境）；缺值的 token 槽位不写（xterm 用内置默认）。
 */
export function xtermPaletteFromTokens(tokens: Record<string, string>): ITheme {
  const theme: Record<string, string> = {};
  for (const [slot, token] of Object.entries(PALETTE_TOKENS)) {
    const value = tokens[token];
    if (value !== undefined && value !== "") theme[slot] = value;
  }
  for (const key of BRIGHT_SAME_KEYS) {
    const value = tokens[PALETTE_TOKENS[key]];
    if (value !== undefined && value !== "")
      theme[`bright${capitalize(key)}`] = value;
  }
  return theme;
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * 读取当前生效主题（documentElement 的 computed style 解析出 CSS 变量值）
 * 并换算为 xterm palette；html data-theme 翻转时重调（TerminalSessionView
 * 的 MutationObserver 驱动）。
 */
export function terminalXtermTheme(): ITheme {
  if (typeof document === "undefined") return {};
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const token of Object.values(PALETTE_TOKENS)) {
    const value = style.getPropertyValue(token).trim();
    if (value !== "") tokens[token] = value;
  }
  return xtermPaletteFromTokens(tokens);
}
