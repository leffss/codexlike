import { describe, expect, it } from "vitest";

import { createOscTitleScanner } from "../../src/terminal/osc-title";

/** 便捷构造：OSC Ps;Pt 序列（BEL 终止） */
function osc(code: string, title: string): string {
  return `\u001b]${code};${title}\u0007`;
}

describe("OscTitleScanner：OSC 0/2 标题增量解析", () => {
  it("OSC 0（BEL 终止）单 chunk 完整到达 → 返回标题", () => {
    const scanner = createOscTitleScanner();
    expect(scanner.feed(osc("0", "MINGW64:/tmp"))).toBe("MINGW64:/tmp");
  });

  it("OSC 2（ST 终止 ESC \\）→ 返回标题", () => {
    const scanner = createOscTitleScanner();
    expect(scanner.feed("\u001b]2;部署终端\u001b\\")).toBe("部署终端");
  });

  it("序列跨 chunk 拆开（ESC ] 0 ; ti | tle BEL）→ 重组后返回", () => {
    const scanner = createOscTitleScanner();
    expect(scanner.feed("\u001b]0;ti")).toBeNull();
    expect(scanner.feed("tle\u0007")).toBe("title");
  });

  it("普通输出与 CSI 序列穿过不误报，后续标题仍可识别", () => {
    const scanner = createOscTitleScanner();
    expect(scanner.feed("hello \u001b[32mworld\u001b[m\r\n$ ")).toBeNull();
    expect(scanner.feed(osc("2", "cwd"))).toBe("cwd");
  });

  it("非 0/2 序列（如 OSC 52 剪贴板）不产出标题", () => {
    const scanner = createOscTitleScanner();
    expect(scanner.feed(osc("52", "c;aGVsbG8="))).toBeNull();
  });

  it("conpty 初始标题回声（盘符 .exe 绝对路径）不产出；shell 自选标题照常", () => {
    const scanner = createOscTitleScanner();
    // powershell 启动时 conpty 回声 exe 绝对路径——呈现价值为负，过滤
    expect(
      scanner.feed(
        osc(
          "0",
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        )
      )
    ).toBeNull();
    // shell 自选标题（git-bash MINGW64:/tmp、cmd.exe）照常产出
    expect(scanner.feed(osc("0", "MINGW64:/tmp"))).toBe("MINGW64:/tmp");
    expect(scanner.feed(osc("0", "cmd.exe"))).toBe("cmd.exe");
  });

  it("同一 chunk 连发多条标题序列：保留最后一条", () => {
    const scanner = createOscTitleScanner();
    expect(scanner.feed(`${osc("0", "first")}${osc("2", "second")}`)).toBe(
      "second"
    );
  });

  it("空标题与超长标题不产出", () => {
    const scanner = createOscTitleScanner();
    expect(scanner.feed(osc("0", ""))).toBeNull();
    expect(scanner.feed(osc("2", "x".repeat(201)))).toBeNull();
    expect(scanner.feed(osc("2", "x".repeat(200)))).toBe("x".repeat(200));
  });

  it("畸形序列（ESC ] 0 ; abc ESC x）中断后扫描器恢复：后续标题仍识别", () => {
    const scanner = createOscTitleScanner();
    expect(scanner.feed(`\u001b]0;abc\u001bx`)).toBeNull();
    expect(scanner.feed(osc("0", "recovered"))).toBe("recovered");
  });

  it("标题含分号（title 本体带 ;）只按第一个分号切 code", () => {
    const scanner = createOscTitleScanner();
    expect(scanner.feed(osc("0", "a;b;c"))).toBe("a;b;c");
  });
});
