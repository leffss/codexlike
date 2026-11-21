import { describe, expect, it } from "vitest";

import { xtermPaletteFromTokens } from "../src/lib/terminal-theme";

describe("terminal-theme：语义 token → xterm palette（一处收口映射）", () => {
  it("基础面槽位取对应语义 token（背景/前景/光标/选区高亮墨）", () => {
    const palette = xtermPaletteFromTokens({
      "--canvas": "#1f1e1c",
      "--fg": "#e6e4df",
      "--terminal-selection": "#e6e4df",
    });
    expect(palette.background).toBe("#1f1e1c");
    expect(palette.foreground).toBe("#e6e4df");
    expect(palette.cursor).toBe("#e6e4df");
    expect(palette.cursorAccent).toBe("#1f1e1c");
    // 选区基色 = 不透明高亮墨（--terminal-selection，与前景同墨）：xterm DOM
    // renderer 把主题选区色与背景 blend 成不透明 overlay 压在字形上方，低透明
    // 度 token 会被 blend 吃掉 α、混出 ≈ 背景色整块盖字（2026-11-21 选中不可
    // 读 bug）；配合 styles.css 对 overlay div 的 opacity 压制，字形区混合色
    // 恒等于字形原色，空区呈淡墨高亮
    expect(palette.selectionBackground).toBe("#e6e4df");
  });

  it("ANSI 16 色借语义色 token：red/green/yellow/blue/magenta/cyan/white + black", () => {
    const palette = xtermPaletteFromTokens({
      "--accent": "#e8e6e1",
      "--danger-fg": "#e8a29c",
      "--ok-fg": "#89b48a",
      "--warn-fg": "#d8b25c",
      "--info-fg": "#6ea5e8",
      "--worktree-fg": "#b489d8",
      "--subagent-fg": "#6bb5b0",
      "--fg-muted": "#a09e99",
    });
    expect(palette.black).toBe("#e8e6e1");
    expect(palette.red).toBe("#e8a29c");
    expect(palette.green).toBe("#89b48a");
    expect(palette.yellow).toBe("#d8b25c");
    expect(palette.blue).toBe("#6ea5e8");
    expect(palette.magenta).toBe("#b489d8");
    expect(palette.cyan).toBe("#6bb5b0");
    expect(palette.white).toBe("#a09e99");
  });

  it("bright 系列与基础系列同色；brightBlack 取最弱前景、brightWhite 取前景主色", () => {
    const palette = xtermPaletteFromTokens({
      "--danger-fg": "#e8a29c",
      "--ok-fg": "#89b48a",
      "--warn-fg": "#d8b25c",
      "--info-fg": "#6ea5e8",
      "--worktree-fg": "#b489d8",
      "--subagent-fg": "#6bb5b0",
      "--fg-muted": "#a09e99",
      "--fg-subtle": "#75736e",
      "--fg": "#e6e4df",
    });
    expect(palette.brightRed).toBe("#e8a29c");
    expect(palette.brightGreen).toBe("#89b48a");
    expect(palette.brightYellow).toBe("#d8b25c");
    expect(palette.brightBlue).toBe("#6ea5e8");
    expect(palette.brightMagenta).toBe("#b489d8");
    expect(palette.brightCyan).toBe("#6bb5b0");
    expect(palette.brightWhite).toBe("#a09e99");
    expect(palette.brightBlack).toBe("#75736e");
  });

  it("缺值 token 槽位不写（xterm 落内置默认，不产生空串色值）", () => {
    const palette = xtermPaletteFromTokens({ "--fg": "#37352f" });
    expect(palette.foreground).toBe("#37352f");
    expect(palette.background).toBeUndefined();
    expect(palette.red).toBeUndefined();
  });
});
