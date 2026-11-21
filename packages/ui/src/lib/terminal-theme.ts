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
 */

/** xterm palette 消费的语义色值表（全部为 CSS 变量名，读取时求值） */
const PALETTE_TOKENS = {
  background: "--canvas",
  foreground: "--fg",
  cursor: "--fg",
  cursorAccent: "--canvas",
  selectionBackground: "--selected",
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
