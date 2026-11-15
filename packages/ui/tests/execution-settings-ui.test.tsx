import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { parseToolRoundsInput } from "../src/lib/execution-settings-form";
import { ExecutionSettingsBody, SettingsPage } from "../src/pages/SettingsPage";

/**
 * 执行设置分区（ADR 0017，GLOSSARY「执行设置」「工具轮次」）：
 * 校验为纯函数（合法整数生效，非法/越界输入回退默认 200）；分区渲染为
 * 静态标记断言——文案遵循 GLOSSARY 术语（「工具轮次」，不用「回合」）。
 */
describe("执行设置输入解析（parseToolRoundsInput）", () => {
  it("范围内的整数原样生效；边界 10 与 1000 合法", () => {
    expect(parseToolRoundsInput("200")).toBe(200);
    expect(parseToolRoundsInput("500")).toBe(500);
    expect(parseToolRoundsInput("10")).toBe(10);
    expect(parseToolRoundsInput("1000")).toBe(1000);
    expect(parseToolRoundsInput(" 42 ")).toBe(42);
  });

  it("非法/越界输入回退默认 200（ADR 0017）", () => {
    expect(parseToolRoundsInput("9")).toBe(200);
    expect(parseToolRoundsInput("1001")).toBe(200);
    expect(parseToolRoundsInput("1.5")).toBe(200);
    expect(parseToolRoundsInput("abc")).toBe(200);
    expect(parseToolRoundsInput("")).toBe(200);
    // 空串经 Number 归一为 0，同样越界回退
    expect(parseToolRoundsInput("0")).toBe(200);
    expect(parseToolRoundsInput("-5")).toBe(200);
  });
});

describe("执行设置分区渲染", () => {
  it("表单体：数字输入携带范围约束与当前值，保存按钮与提示位存在", () => {
    const html = renderToStaticMarkup(
      createElement(ExecutionSettingsBody, {
        maxToolRounds: "500",
        onInput: () => {},
        onSave: () => {},
        saving: false,
        message: "",
        messageError: false,
      })
    );
    expect(html).toContain('data-testid="execution-settings"');
    expect(html).toContain("主任务工具轮次上限");
    expect(html).toContain('data-testid="execution-tool-rounds-input"');
    expect(html).toContain('value="500"');
    expect(html).toContain('min="10"');
    expect(html).toContain('max="1000"');
    expect(html).toContain('data-testid="execution-settings-save"');
    // 文案术语：工具轮次（GLOSSARY），不出现「回合」
    expect(html).toContain("工具轮次");
    expect(html).not.toContain("回合");
  });

  it("保存提示：成功为 ok 色、失败为 danger 色", () => {
    const ok = renderToStaticMarkup(
      createElement(ExecutionSettingsBody, {
        maxToolRounds: "200",
        onInput: () => {},
        onSave: () => {},
        saving: false,
        message: "已保存",
        messageError: false,
      })
    );
    expect(ok).toContain('data-testid="execution-settings-message"');
    expect(ok).toContain("已保存");
    expect(ok).toContain("text-ok-fg");

    const failed = renderToStaticMarkup(
      createElement(ExecutionSettingsBody, {
        maxToolRounds: "200",
        onInput: () => {},
        onSave: () => {},
        saving: false,
        message: "保存失败",
        messageError: true,
      })
    );
    expect(failed).toContain("text-danger-fg");
  });

  it("设置页出现「执行」分区，介绍文案遵循 GLOSSARY 术语", () => {
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(html).toContain("执行");
    expect(html).toContain("已开始的执行用开始时的值");
    expect(html).not.toContain("回合");
  });
});
