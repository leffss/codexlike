import { describe, expect, it } from "vitest";

import {
  isExitedTerminalStatus,
  originLabel,
  statusDotClassName,
  statusPulses,
  statusText,
  terminalElapsed,
  terminalStatusClass,
} from "../src/lib/terminal-status";
import type { TerminalSegment } from "../src/lib/task-view";

/** 终端段样例构造（state 与 record 字段对齐 TerminalSessionRecord） */
function termSeg(overrides: Partial<TerminalSegment> = {}): TerminalSegment {
  return {
    kind: "terminal",
    id: "term-1",
    seq: 1,
    turnId: "u1",
    responseId: null,
    sessionId: "term-1",
    name: "git-bash · 1",
    shell: "git-bash",
    origin: "user",
    status: "running",
    createdAt: "2026-11-21T08:00:00.000Z",
    ...overrides,
  };
}

describe("terminal-status：状态文案（rail 富行 / 详情顶栏单一来源）", () => {
  it("running →「运行中」", () => {
    expect(statusText(termSeg())).toBe("运行中");
  });
  it("exited 正常（exitCode 0）→「已退出」", () => {
    expect(statusText(termSeg({ status: "exited", exitCode: 0 }))).toBe(
      "已退出"
    );
  });
  it("exited 异常码 →「退出码 N」（帮用户一眼看出非零失败）", () => {
    expect(statusText(termSeg({ status: "exited", exitCode: 1 }))).toBe(
      "退出码 1"
    );
  });
  it("exited 信号终止（kill/taskkill）→「已终止（信号 N）」，优先于退出码", () => {
    expect(
      statusText(termSeg({ status: "exited", exitCode: 1, signal: 9 }))
    ).toBe("已终止（信号 9）");
  });
  it("exited 无退出码（防御）→「已退出」", () => {
    expect(statusText(termSeg({ status: "exited" }))).toBe("已退出");
  });
});

describe("terminal-status：配色与脉冲（状态点 / 状态文字同源）", () => {
  it("running 黄脉冲（与子代理 running 语汇一致）", () => {
    const seg = termSeg();
    expect(statusDotClassName(seg)).toBe("bg-warn-fg");
    expect(statusPulses(seg)).toBe(true);
    expect(terminalStatusClass(seg)).toBe("text-warn-fg");
  });
  it("正常退出绿静态；异常退出红；信号终止黄静态（用户 kill 非失败）", () => {
    const ok = termSeg({ status: "exited", exitCode: 0 });
    const fail = termSeg({ status: "exited", exitCode: 1 });
    const killed = termSeg({ status: "exited", exitCode: 1, signal: 9 });
    expect(statusDotClassName(ok)).toBe("bg-ok-fg");
    expect(statusDotClassName(fail)).toBe("bg-danger-fg");
    expect(statusDotClassName(killed)).toBe("bg-warn-fg");
    expect(statusPulses(ok)).toBe(false);
    expect(statusPulses(killed)).toBe(false);
    expect(terminalStatusClass(ok)).toBe("text-ok-fg");
    expect(terminalStatusClass(fail)).toBe("text-danger-fg");
    expect(terminalStatusClass(killed)).toBe("text-warn-fg");
  });
  it("isExitedTerminalStatus：详情页只读回看与 kill 按钮显隐的终态判定", () => {
    expect(isExitedTerminalStatus(termSeg().status)).toBe(false);
    expect(isExitedTerminalStatus(termSeg({ status: "exited" }).status)).toBe(
      true
    );
  });
});

describe("terminal-status：来源标注（列表富行「用户 / agent」）", () => {
  it("user → 用户；agent → agent（agent 侧不翻译，GLOSSARY 专有名词口径）", () => {
    expect(originLabel(termSeg().origin)).toBe("用户");
    expect(originLabel(termSeg({ origin: "agent" }).origin)).toBe("agent");
  });
});

describe("terminal-status：已用时（running 跳动 / exited 定格）", () => {
  it("running 以传入 now 实时计算", () => {
    const seg = termSeg();
    expect(terminalElapsed(seg, Date.parse("2026-11-21T08:01:05.000Z"))).toBe(
      "01:05"
    );
  });
  it("exited 以 exitedAt 定格（不随 now 跳动）", () => {
    const seg = termSeg({
      status: "exited",
      exitCode: 0,
      exitedAt: "2026-11-21T08:00:30.000Z",
    });
    expect(terminalElapsed(seg, Date.parse("2026-11-21T08:09:00.000Z"))).toBe(
      "00:30"
    );
  });
  it("exited 缺 exitedAt（防御）不显示数字", () => {
    const seg = termSeg({ status: "exited", exitCode: 0 });
    expect(
      terminalElapsed(seg, Date.parse("2026-11-21T08:09:00.000Z"))
    ).toBeNull();
  });
  it("跨小时会话按累计分钟显示（mm:ss，与子代理 formatElapsed 同款语汇）", () => {
    const seg = termSeg({
      status: "exited",
      exitCode: 0,
      exitedAt: "2026-11-21T09:30:00.000Z",
    });
    expect(terminalElapsed(seg, 0)).toBe("90:00");
  });
});
