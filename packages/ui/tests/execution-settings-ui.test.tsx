import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  parseCompactKeepRoundsInput,
  parseContextWarningPercentInput,
  parseTaskConcurrencyLimitInput,
  parseToolRoundsInput,
} from "../src/lib/execution-settings-form";
import { ExecutionSettingsBody, SettingsPage } from "../src/pages/SettingsPage";

/**
 * 执行设置分区（ADR 0017，GLOSSARY「执行设置」「工具轮次」）：
 * 校验为纯函数（合法整数生效，非法/越界输入回退默认）；分区渲染为
 * 静态标记断言——文案遵循 GLOSSARY 术语（「工具轮次」，不用「回合」）。
 * 五项参数（执行设置票 01/02/03 + 任务并发上限票 01）：主任务与子代理工具
 * 轮次上限（10–1000，默认 200）、压缩保留对话轮数（1–10，默认 3）、上下文
 * 告警阈值（百分比呈现，50–95、默认 80）、任务并发上限（1–8，默认 3）。
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

  it("回退默认值可指定（票 02 子代理项）：同一范围，回退到传入的默认来源", () => {
    // 主任务项与子代理项默认值同为 200，但来源是各自的常量（防语义耦合后分叉）
    expect(parseToolRoundsInput("abc", 200)).toBe(200);
    expect(parseToolRoundsInput("9", 200)).toBe(200);
    expect(parseToolRoundsInput("1001", 200)).toBe(200);
    // 合法值与回退来源无关
    expect(parseToolRoundsInput("42", 200)).toBe(42);
  });
});

describe("执行设置输入解析（票 03 两项）", () => {
  it("压缩保留轮数：1–10 的整数生效；非法/越界回退默认 3", () => {
    expect(parseCompactKeepRoundsInput("3")).toBe(3);
    expect(parseCompactKeepRoundsInput("7")).toBe(7);
    expect(parseCompactKeepRoundsInput("1")).toBe(1);
    expect(parseCompactKeepRoundsInput("10")).toBe(10);
    for (const bad of ["0", "11", "2.5", "abc", "", "-1"]) {
      expect(parseCompactKeepRoundsInput(bad)).toBe(3);
    }
  });

  it("上下文告警阈值：50–95 的整数百分比生效；非法/越界回退默认 80", () => {
    expect(parseContextWarningPercentInput("80")).toBe(80);
    expect(parseContextWarningPercentInput("50")).toBe(50);
    expect(parseContextWarningPercentInput("95")).toBe(95);
    expect(parseContextWarningPercentInput(" 65 ")).toBe(65);
    for (const bad of ["49", "96", "80.5", "abc", "", "0", "-5"]) {
      expect(parseContextWarningPercentInput(bad)).toBe(80);
    }
  });
});

describe("执行设置输入解析（任务并发上限票 01）", () => {
  it("任务并发上限：1–8 的整数生效（含边界）；非法/越界回退默认 3", () => {
    expect(parseTaskConcurrencyLimitInput("3")).toBe(3);
    expect(parseTaskConcurrencyLimitInput("5")).toBe(5);
    expect(parseTaskConcurrencyLimitInput("1")).toBe(1);
    expect(parseTaskConcurrencyLimitInput("8")).toBe(8);
    for (const bad of ["0", "9", "2.5", "abc", "", "-1"]) {
      expect(parseTaskConcurrencyLimitInput(bad)).toBe(3);
    }
  });
});

describe("执行设置分区渲染", () => {
  function renderBody(overrides?: {
    maxToolRounds?: string;
    maxSubagentToolRounds?: string;
    compactKeepRounds?: string;
    contextWarningThresholdPercent?: string;
    taskConcurrencyLimit?: string;
  }) {
    return renderToStaticMarkup(
      createElement(ExecutionSettingsBody, {
        maxToolRounds: overrides?.maxToolRounds ?? "500",
        maxSubagentToolRounds: overrides?.maxSubagentToolRounds ?? "300",
        compactKeepRounds: overrides?.compactKeepRounds ?? "7",
        contextWarningThresholdPercent:
          overrides?.contextWarningThresholdPercent ?? "65",
        taskConcurrencyLimit: overrides?.taskConcurrencyLimit ?? "6",
        onInput: () => {},
        onSubagentInput: () => {},
        onCompactKeepInput: () => {},
        onContextWarningInput: () => {},
        onTaskConcurrencyInput: () => {},
        onSave: () => {},
        saving: false,
        message: "",
        messageError: false,
      })
    );
  }

  it("表单体：主任务项数字输入携带范围约束与当前值", () => {
    const html = renderBody();
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

  it("表单体：子代理项与主任务项并排同构（票 02），独立输入与当前值", () => {
    const html = renderBody({ maxSubagentToolRounds: "300" });
    expect(html).toContain("子代理工具轮次上限");
    expect(html).toContain(
      'data-testid="execution-subagent-tool-rounds-input"'
    );
    expect(html).toContain('value="300"');
    // 同一合法范围 10–1000
    expect(html).toContain('min="10"');
    expect(html).toContain('max="1000"');
    // 两项并存且各一个输入
    expect(html.match(/execution-tool-rounds-input/g)).toHaveLength(1);
    expect(html.match(/execution-subagent-tool-rounds-input/g)).toHaveLength(1);
  });

  it("表单体：压缩保留轮数项（票 03）范围 1–10 与当前值", () => {
    const html = renderBody({ compactKeepRounds: "7" });
    expect(html).toContain("压缩保留对话轮数");
    expect(html).toContain('data-testid="execution-compact-keep-input"');
    expect(html).toContain('value="7"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="10"');
    expect(html.match(/execution-compact-keep-input/g)).toHaveLength(1);
    // 说明文案：改动对下一次压缩生效（逐次读取，无回合快照）
    expect(html).toContain("/compact");
  });

  it("表单体：上下文告警阈值项（票 03）以百分比呈现，范围 50–95 与当前值", () => {
    const html = renderBody({ contextWarningThresholdPercent: "65" });
    expect(html).toContain("上下文告警阈值");
    expect(html).toContain('data-testid="execution-context-warning-input"');
    expect(html).toContain('value="65"');
    expect(html).toContain('min="50"');
    expect(html).toContain('max="95"');
    expect(html.match(/execution-context-warning-input/g)).toHaveLength(1);
    // 呈现语义：占上下文窗口的百分比，与 Provider Profile 窗口叠加
    expect(html).toContain("上下文窗口");
  });

  it("表单体：任务并发上限项（任务并发上限票 01）范围 1–8 与当前值", () => {
    const html = renderBody({ taskConcurrencyLimit: "6" });
    expect(html).toContain("任务并发上限");
    expect(html).toContain('data-testid="execution-task-concurrency-input"');
    expect(html).toContain('value="6"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="8"');
    expect(html.match(/execution-task-concurrency-input/g)).toHaveLength(1);
    // 说明文案：达到上限时新任务排队（GLOSSARY「任务排队」语义）
    expect(html).toContain("排队");
  });

  it("表单体：五项并存各一个输入（执行设置票 01/02/03 + 任务并发上限票 01 累计）", () => {
    const html = renderBody();
    for (const testid of [
      "execution-tool-rounds-input",
      "execution-subagent-tool-rounds-input",
      "execution-compact-keep-input",
      "execution-context-warning-input",
      "execution-task-concurrency-input",
    ]) {
      expect(html.match(new RegExp(testid, "g"))).toHaveLength(1);
    }
  });

  it("保存提示：成功为 ok 色、失败为 danger 色", () => {
    const ok = renderToStaticMarkup(
      createElement(ExecutionSettingsBody, {
        maxToolRounds: "200",
        maxSubagentToolRounds: "200",
        compactKeepRounds: "3",
        contextWarningThresholdPercent: "80",
        taskConcurrencyLimit: "3",
        onInput: () => {},
        onSubagentInput: () => {},
        onCompactKeepInput: () => {},
        onContextWarningInput: () => {},
        onTaskConcurrencyInput: () => {},
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
        maxSubagentToolRounds: "200",
        compactKeepRounds: "3",
        contextWarningThresholdPercent: "80",
        taskConcurrencyLimit: "3",
        onInput: () => {},
        onSubagentInput: () => {},
        onCompactKeepInput: () => {},
        onContextWarningInput: () => {},
        onTaskConcurrencyInput: () => {},
        onSave: () => {},
        saving: false,
        message: "保存失败",
        messageError: true,
      })
    );
    expect(failed).toContain("text-danger-fg");
  });

  it("设置页出现「执行」分区，介绍文案遵循 GLOSSARY 术语", () => {
    // 静态渲染下 IPC 装载不发生（loaded=false），表体不挂载——分区项在
    // 表体级测试断言（同票 01 页级测试先例）
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(html).toContain("执行");
    expect(html).toContain("已开始的执行用开始时的值");
    expect(html).not.toContain("回合");
  });
});
