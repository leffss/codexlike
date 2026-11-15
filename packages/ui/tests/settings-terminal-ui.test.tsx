import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingsPage } from "../src/pages/SettingsPage";
import { validateTerminalTimeouts } from "../src/lib/terminal-settings";

/**
 * 终端设置分区（执行设置票04）：命令超时与最大命令超时两项的
 * 渲染与联动校验（命令超时 ≤ 最大命令超时，越界/非法输入阻止保存）。
 */
describe("validateTerminalTimeouts（终端超时联动校验）", () => {
  it("合法输入返回 null", () => {
    expect(validateTerminalTimeouts("30", "120")).toBeNull();
    expect(validateTerminalTimeouts("5", "10")).toBeNull();
    expect(validateTerminalTimeouts("600", "1800")).toBeNull();
    expect(validateTerminalTimeouts("120", "120")).toBeNull();
  });

  it("命令超时越界或非法（非整数、空串）返回中文错误", () => {
    expect(validateTerminalTimeouts("4", "120")).toBe(
      "命令超时必须是 5-600 的整数（秒）"
    );
    expect(validateTerminalTimeouts("601", "1200")).toBe(
      "命令超时必须是 5-600 的整数（秒）"
    );
    expect(validateTerminalTimeouts("30.5", "120")).toBe(
      "命令超时必须是 5-600 的整数（秒）"
    );
    expect(validateTerminalTimeouts("", "120")).toBe(
      "命令超时必须是 5-600 的整数（秒）"
    );
    expect(validateTerminalTimeouts("abc", "120")).toBe(
      "命令超时必须是 5-600 的整数（秒）"
    );
  });

  it("最大命令超时越界或非法返回中文错误", () => {
    expect(validateTerminalTimeouts("30", "9")).toBe(
      "最大命令超时必须是 10-1800 的整数（秒）"
    );
    expect(validateTerminalTimeouts("30", "1801")).toBe(
      "最大命令超时必须是 10-1800 的整数（秒）"
    );
    expect(validateTerminalTimeouts("30", "")).toBe(
      "最大命令超时必须是 10-1800 的整数（秒）"
    );
    expect(validateTerminalTimeouts("30", "abc")).toBe(
      "最大命令超时必须是 10-1800 的整数（秒）"
    );
  });

  it("联动校验：命令超时大于最大命令超时被阻止", () => {
    expect(validateTerminalTimeouts("300", "120")).toBe(
      "命令超时不能大于最大命令超时"
    );
  });
});

describe("设置页终端分区渲染", () => {
  it("终端分区标题与命令超时两项说明可见", () => {
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(html).toMatch(/<h2[^>]*>终端执行<\/h2>/);
    expect(html).toContain("命令超时");
    expect(html).toContain("最大命令超时");
  });
});
