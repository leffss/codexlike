import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  parseMcpCallTimeoutInput,
  parseMcpConnectTimeoutInput,
} from "../src/lib/execution-settings-form";
import { McpTimeoutSettingsBody } from "../src/components/McpSettingsSection";

/**
 * MCP 设置分区超时两项（执行设置票 07）：校验为纯函数（合法整数生效，
 * 非法/越界输入回退默认，与执行分区解析同规则）；分区表体为静态标记断言。
 * 工具调用超时默认 30、范围 5–300 秒；连接超时默认 15、范围 5–120 秒。
 */
describe("MCP 超时输入解析（parseMcpCallTimeoutInput）", () => {
  it("范围内的整数原样生效；边界 5 与 300 合法", () => {
    expect(parseMcpCallTimeoutInput("30")).toBe(30);
    expect(parseMcpCallTimeoutInput("120")).toBe(120);
    expect(parseMcpCallTimeoutInput("5")).toBe(5);
    expect(parseMcpCallTimeoutInput("300")).toBe(300);
    expect(parseMcpCallTimeoutInput(" 60 ")).toBe(60);
  });

  it("非法/越界输入回退默认 30（ADR 0017）", () => {
    for (const bad of ["4", "301", "10.5", "abc", "", "0", "-5"]) {
      expect(parseMcpCallTimeoutInput(bad)).toBe(30);
    }
  });
});

describe("MCP 超时输入解析（parseMcpConnectTimeoutInput）", () => {
  it("范围内的整数原样生效；边界 5 与 120 合法", () => {
    expect(parseMcpConnectTimeoutInput("15")).toBe(15);
    expect(parseMcpConnectTimeoutInput("60")).toBe(60);
    expect(parseMcpConnectTimeoutInput("5")).toBe(5);
    expect(parseMcpConnectTimeoutInput("120")).toBe(120);
  });

  it("非法/越界输入回退默认 15（ADR 0017）", () => {
    for (const bad of ["4", "121", "7.5", "abc", "", "0", "-5"]) {
      expect(parseMcpConnectTimeoutInput(bad)).toBe(15);
    }
  });
});

describe("MCP 分区超时表体渲染", () => {
  function renderBody(overrides?: {
    callTimeout?: string;
    connectTimeout?: string;
    message?: string;
    messageError?: boolean;
  }) {
    return renderToStaticMarkup(
      createElement(McpTimeoutSettingsBody, {
        callTimeout: overrides?.callTimeout ?? "90",
        connectTimeout: overrides?.connectTimeout ?? "45",
        onCallInput: () => {},
        onConnectInput: () => {},
        onSave: () => {},
        saving: false,
        message: overrides?.message ?? "",
        messageError: overrides?.messageError ?? false,
      })
    );
  }

  it("工具调用超时项：数字输入携带范围约束（5-300）与当前值", () => {
    const html = renderBody();
    expect(html).toContain("工具调用超时");
    expect(html).toContain('data-testid="mcp-call-timeout-input"');
    expect(html).toContain('value="90"');
    expect(html).toContain('min="5"');
    expect(html).toContain('max="300"');
    expect(html.match(/mcp-call-timeout-input/g)).toHaveLength(1);
  });

  it("连接超时项：数字输入携带范围约束（5-120）与当前值，两项并存各一个", () => {
    const html = renderBody();
    expect(html).toContain("连接超时");
    expect(html).toContain('data-testid="mcp-connect-timeout-input"');
    expect(html).toContain('value="45"');
    expect(html).toContain('min="5"');
    expect(html).toContain('max="120"');
    expect(html.match(/mcp-connect-timeout-input/g)).toHaveLength(1);
  });

  it("保存按钮与生效说明可见（下一次连接/工具调用生效，无需重启）", () => {
    const html = renderBody();
    expect(html).toContain('data-testid="mcp-timeout-settings-save"');
    expect(html).toContain("下一次");
  });

  it("保存提示：成功为 ok 色、失败为 danger 色", () => {
    const ok = renderBody({ message: "已保存", messageError: false });
    expect(ok).toContain('data-testid="mcp-timeout-settings-message"');
    expect(ok).toContain("text-ok-fg");
    const failed = renderBody({ message: "保存失败", messageError: true });
    expect(failed).toContain("text-danger-fg");
  });
});
