import { describe, expect, it, vi } from "vitest";

import type { AgentSettings, CodexLikeApi } from "@codexlike/desktop/ipc";

import { contextWarningMessage } from "../src/lib/context-warning";

/**
 * 上下文告警阈值的消费接线（执行设置票 03，ADR 0017）：WorkspacePage 的
 * 告警评估改读执行设置——每次刷新逐次读取（IPC get，无快照语义），整数
 * 百分比换算为占比传给 agent-core 的 evaluateContextWarning（窗口仍来自
 * Provider Profile，两者叠加关系不变）。设置读取失败回退默认阈值
 * （告警本身「查询失败静默不打扰」，不因设置读取失败改变行为）。
 *
 * Seam：lib 纯函数 + 注入的 api（Pick agentSettings）——WorkspacePage 组件
 * 不直接单测（既有先例），接线的可观察行为在此覆盖。
 */

/** /status 数据形状（ui 侧消费的字段） */
function status(
  estimatedContextTokens: number,
  contextWindowTokens: number | null = 128_000
) {
  return { estimatedContextTokens, contextWindowTokens };
}

function settingsOf(percent: number): AgentSettings {
  return {
    maxToolRounds: 200,
    maxSubagentToolRounds: 200,
    compactKeepRounds: 3,
    contextWarningThresholdPercent: percent,
    mcpCallTimeoutSeconds: 30,
    mcpConnectTimeoutSeconds: 15,
  };
}

function apiWith(
  settings: { contextWarningThresholdPercent: number } | "throw"
): Pick<CodexLikeApi, "agentSettings"> {
  return {
    agentSettings: {
      get: vi.fn(async () =>
        settings === "throw"
          ? Promise.reject(new Error("boom"))
          : settingsOf(settings.contextWarningThresholdPercent)
      ),
      set: vi.fn(async (input: AgentSettings) => input),
    },
  };
}

describe("contextWarningMessage（告警阈值逐次读取）", () => {
  it("阈值来自设置：50% 时 64k/128k 即告警（默认 80% 下不告警的量）", async () => {
    const api = apiWith({ contextWarningThresholdPercent: 50 });
    const message = await contextWarningMessage(api, status(64_000));
    expect(message).not.toBeNull();
    expect(message).toContain("/compact");
  });

  it("阈值来自设置：95% 时 80% 用量不再告警（默认 80% 下会告警的量）", async () => {
    const api = apiWith({ contextWarningThresholdPercent: 95 });
    expect(await contextWarningMessage(api, status(102_400))).toBeNull();
    expect(await contextWarningMessage(api, status(121_600))).not.toBeNull();
  });

  it("每次调用重新读取设置（逐次读取，无快照）：同 api 两次调用阈值可不同", async () => {
    let percent = 95;
    const api = {
      agentSettings: {
        get: vi.fn(async () => settingsOf(percent)),
        set: vi.fn(async (input: AgentSettings) => input),
      },
    } satisfies Pick<CodexLikeApi, "agentSettings">;
    expect(await contextWarningMessage(api, status(102_400))).toBeNull();
    percent = 50;
    expect(await contextWarningMessage(api, status(102_400))).not.toBeNull();
    expect(api.agentSettings.get).toHaveBeenCalledTimes(2);
  });

  it("设置读取失败：按默认阈值 80% 评估（不抛错、不告警降级）", async () => {
    const api = apiWith("throw");
    expect(await contextWarningMessage(api, status(101_999))).toBeNull();
    expect(await contextWarningMessage(api, status(102_400))).not.toBeNull();
  });

  it("status 无窗口（contextWindowTokens null）：按默认 128k 与注入阈值评估", async () => {
    const api = apiWith({ contextWarningThresholdPercent: 50 });
    expect(await contextWarningMessage(api, status(63_999, null))).toBeNull();
    expect(
      await contextWarningMessage(api, status(64_000, null))
    ).not.toBeNull();
  });
});
