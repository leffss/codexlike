// @vitest-environment jsdom
// MCP 设置分区：超时两项输入解析与表体渲染（node 断言在 jsdom 下同样成立）+
// 逐工具启停乐观更新的交互面（jsdom + testing-library，先例 process-pills-bar-ui）。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// ===== 逐工具启停乐观更新（jsdom 交互）=====
// 受控 checkbox 的 change 事件同步阶段，React 会把 DOM checked 回写为当前
// state；IPC 往返完成前若不乐观翻转本地 state，点击呈现「勾上→闪回」
// （desktop e2e mcp 场景 check() 断言稳定踩中的窗口，2026-11-23 修复轮）。
// jsdom 走同一套 ReactDOM 受控逻辑，点击后同步读 checked 即可复现该窗口。
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { McpSettingsSection } from "../src/components/McpSettingsSection";

const ipc = vi.hoisted(() => {
  const state = {
    toggleCalls: [] as Array<[string, boolean]>,
    releaseToggle: null as null | (() => void),
    disabledTools: new Set<string>(),
  };
  const stub = {
    overview: async () => ({
      servers: [
        {
          config: { id: "srv-1", name: "fake", command: "node", args: ["x"] },
          status: "connected",
          error: null,
          tools: [
            { name: "mcp_fake_echo", description: "回声", enabled: true },
            {
              name: "mcp_fake_crash",
              description: "崩溃样例",
              enabled: !state.disabledTools.has("mcp_fake_crash"),
            },
          ],
        },
      ],
    }),
    // IPC 手工放行：toggle 调用先挂起，releaseToggle 模拟主进程生效
    //（disabled 集合更新后 refresh 可见），复刻「乐观先行、往返后校准」。
    setToolEnabled: (toolName: string, enabled: boolean) => {
      state.toggleCalls.push([toolName, enabled]);
      return new Promise<void>((resolve) => {
        state.releaseToggle = () => {
          if (enabled) state.disabledTools.delete(toolName);
          else state.disabledTools.add(toolName);
          resolve();
        };
      });
    },
  };
  return { state, stub };
});

beforeEach(() => {
  window.codexlike = {
    ...window.codexlike,
    agentSettings: {
      get: async () => ({
        mcpCallTimeoutSeconds: 30,
        mcpConnectTimeoutSeconds: 15,
      }),
    },
    mcp: ipc.stub,
  } as unknown as typeof window.codexlike;
});

afterEach(() => {
  cleanup();
  ipc.state.toggleCalls = [];
  ipc.state.releaseToggle = null;
  ipc.state.disabledTools.clear();
});

describe("逐工具启停乐观更新", () => {
  it("点击瞬间同步翻转呈现（不等 IPC 往返），受控回写不再闪回旧值", async () => {
    render(createElement(McpSettingsSection));
    const crashToggle = (await screen.findByTestId(
      "mcp-tool-toggle-mcp_fake_crash"
    )) as HTMLInputElement;
    expect(crashToggle.checked).toBe(true);

    fireEvent.click(crashToggle);
    // 同步断言：此刻 IPC 仍挂起，property 已与点击一致——乐观翻转让
    // React 的受控回写写入新值；不修复时这里被回写为 true（闪回）。
    expect(crashToggle.checked).toBe(false);
    expect(crashToggle.closest("label")?.textContent).toContain("已禁用");
    expect(ipc.state.toggleCalls).toEqual([["mcp_fake_crash", false]]);

    // IPC 往返生效 → refresh 校准，呈现稳定不回弹
    ipc.state.releaseToggle?.();
    await waitFor(() => {
      expect(ipc.state.toggleCalls).toHaveLength(1);
      expect(crashToggle.checked).toBe(false);
      expect(crashToggle.closest("label")?.textContent).toContain("已禁用");
    });
  });

  it("禁用→再启用同口径：点击瞬间同步勾回，往返后保持", async () => {
    render(createElement(McpSettingsSection));
    const crashToggle = (await screen.findByTestId(
      "mcp-tool-toggle-mcp_fake_crash"
    )) as HTMLInputElement;

    fireEvent.click(crashToggle);
    ipc.state.releaseToggle?.();
    await waitFor(() => {
      expect(crashToggle.checked).toBe(false);
    });

    fireEvent.click(crashToggle);
    // 同步断言：再启用同样不等 IPC，点击瞬间即勾回
    expect(crashToggle.checked).toBe(true);
    expect(crashToggle.closest("label")?.textContent).toContain("已启用");
    expect(ipc.state.toggleCalls).toEqual([
      ["mcp_fake_crash", false],
      ["mcp_fake_crash", true],
    ]);

    ipc.state.releaseToggle?.();
    await waitFor(() => {
      expect(crashToggle.checked).toBe(true);
      expect(crashToggle.closest("label")?.textContent).toContain("已启用");
    });
  });
});
