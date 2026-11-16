import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexLikeApi } from "../../src/shared/ipc";

const bridge = vi.hoisted(() => ({
  api: null as CodexLikeApi | null,
  invoke: vi.fn(async (..._args: unknown[]) => undefined),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: CodexLikeApi) => {
      bridge.api = api;
    },
  },
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => {
      if (bridge.handlers.has(name)) throw new Error(`重复通道 ${name}`);
      bridge.handlers.set(name, fn);
    },
  },
  ipcRenderer: {
    invoke: bridge.invoke,
    on: () => {},
    removeListener: () => {},
  },
}));

import { IPC } from "../../src/shared/ipc";
import {
  createAgentSettingsStore,
  type AgentSettings,
} from "../../src/execution/agent-settings-store";
import { registerAgentSettingsHandlers } from "../../src/execution/agent-settings-ipc";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  bridge.handlers.clear();
  bridge.invoke.mockClear();
  bridge.api = null;
});

/**
 * 执行设置 IPC 链路（ADR 0017）：get/set 频道与现有设置频道同构——
 * 主进程 handler 持有 store（内存缓存由 main.ts 装配层的 onSaved 刷新），
 * 渲染端经 preload 暴露的 agentSettings 命名空间转发同名 channel。
 * 七项参数（执行设置票 01/02/03/07 + 任务并发上限票 01）：主任务与子代理
 * 工具轮次上限、压缩保留对话轮数、上下文告警阈值、MCP 工具调用超时与连接
 * 超时（秒）、任务并发上限（1–8，默认 3）。
 */
describe("agent-settings IPC", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "codexlike-agent-settings-ipc-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = createAgentSettingsStore({ dir });
    const saved: AgentSettings[] = [];
    registerAgentSettingsHandlers({
      store,
      onSaved: async (settings) => {
        saved.push(settings);
      },
    });
    return { store, saved };
  }

  /** async 包裹直调 set handler：边界解析（parseAgentSettingsInput）的同步
   * 抛出统一表现为 promise rejection，与 ipcRenderer.invoke 的渲染端语义
   * 一致（同 terminal-settings-ipc 测试先例） */
  function invokeSet(input: unknown): Promise<unknown> {
    const handler = bridge.handlers.get(IPC.agentSettings.set)!;
    return (async () => handler({}, input))();
  }

  it("get/set 注册到 agent-settings:* 频道；set 落盘并回调 onSaved（内存缓存刷新点）", async () => {
    const { saved } = setup();

    expect(bridge.handlers.has(IPC.agentSettings.get)).toBe(true);
    expect(bridge.handlers.has(IPC.agentSettings.set)).toBe(true);

    // get：未配置返回七项默认值
    await expect(
      bridge.handlers.get(IPC.agentSettings.get)!({}, undefined)
    ).resolves.toEqual({
      maxToolRounds: 200,
      maxSubagentToolRounds: 200,
      compactKeepRounds: 3,
      contextWarningThresholdPercent: 80,
      mcpCallTimeoutSeconds: 30,
      mcpConnectTimeoutSeconds: 15,
      taskConcurrencyLimit: 3,
    });

    // set：合法值返回保存结果、落盘（经 store）并通知装配层刷新内存缓存
    await expect(
      invokeSet({
        maxToolRounds: 500,
        maxSubagentToolRounds: 300,
        compactKeepRounds: 5,
        contextWarningThresholdPercent: 65,
        mcpCallTimeoutSeconds: 120,
        mcpConnectTimeoutSeconds: 60,
        taskConcurrencyLimit: 6,
      })
    ).resolves.toEqual({
      maxToolRounds: 500,
      maxSubagentToolRounds: 300,
      compactKeepRounds: 5,
      contextWarningThresholdPercent: 65,
      mcpCallTimeoutSeconds: 120,
      mcpConnectTimeoutSeconds: 60,
      taskConcurrencyLimit: 6,
    });
    expect(saved).toEqual([
      {
        maxToolRounds: 500,
        maxSubagentToolRounds: 300,
        compactKeepRounds: 5,
        contextWarningThresholdPercent: 65,
        mcpCallTimeoutSeconds: 120,
        mcpConnectTimeoutSeconds: 60,
        taskConcurrencyLimit: 6,
      },
    ]);
    await expect(
      bridge.handlers.get(IPC.agentSettings.get)!({}, undefined)
    ).resolves.toEqual({
      maxToolRounds: 500,
      maxSubagentToolRounds: 300,
      compactKeepRounds: 5,
      contextWarningThresholdPercent: 65,
      mcpCallTimeoutSeconds: 120,
      mcpConnectTimeoutSeconds: 60,
      taskConcurrencyLimit: 6,
    });
  });

  it("set：非法输入以中文异常抛回且不落盘（边界不信任渲染进程）", async () => {
    const { saved } = setup();

    // 越界/非整数 → 边界解析拒绝（四项各自校验，与 store.set 同源同消息）
    await expect(
      invokeSet({
        maxToolRounds: 9,
        maxSubagentToolRounds: 200,
        compactKeepRounds: 3,
        contextWarningThresholdPercent: 80,
      })
    ).rejects.toThrow("主任务工具轮次上限");
    await expect(
      invokeSet({
        maxToolRounds: 200,
        maxSubagentToolRounds: 1001,
        compactKeepRounds: 3,
        contextWarningThresholdPercent: 80,
      })
    ).rejects.toThrow("子代理工具轮次上限");
    // 票 03 两项：压缩保留轮数与告警阈值越界同样拒绝（整数百分比 50–95）
    await expect(
      invokeSet({
        maxToolRounds: 200,
        maxSubagentToolRounds: 200,
        compactKeepRounds: 0,
        contextWarningThresholdPercent: 80,
        mcpCallTimeoutSeconds: 30,
        mcpConnectTimeoutSeconds: 15,
      })
    ).rejects.toThrow("压缩保留对话轮数");
    await expect(
      invokeSet({
        maxToolRounds: 200,
        maxSubagentToolRounds: 200,
        compactKeepRounds: 3,
        contextWarningThresholdPercent: 96,
        mcpCallTimeoutSeconds: 30,
        mcpConnectTimeoutSeconds: 15,
      })
    ).rejects.toThrow("上下文告警阈值");
    // 票 07 两项：MCP 超时越界拒绝（调用 5–300 秒、连接 5–120 秒）
    await expect(
      invokeSet({
        maxToolRounds: 200,
        maxSubagentToolRounds: 200,
        compactKeepRounds: 3,
        contextWarningThresholdPercent: 80,
        mcpCallTimeoutSeconds: 301,
        mcpConnectTimeoutSeconds: 15,
      })
    ).rejects.toThrow("MCP 工具调用超时");
    await expect(
      invokeSet({
        maxToolRounds: 200,
        maxSubagentToolRounds: 200,
        compactKeepRounds: 3,
        contextWarningThresholdPercent: 80,
        mcpCallTimeoutSeconds: 30,
        mcpConnectTimeoutSeconds: 4,
      })
    ).rejects.toThrow("MCP 连接超时");
    // 非数字类型输入（渲染进程伪造）→ 边界解析按类型拒绝（code review 修复 4：
    // 不再经 Number 强转，字符串在 parseAgentSettingsInput 即被拒收）
    await expect(
      invokeSet({
        maxToolRounds: "abc",
        maxSubagentToolRounds: 200,
        compactKeepRounds: 3,
        contextWarningThresholdPercent: 80,
        mcpCallTimeoutSeconds: 30,
        mcpConnectTimeoutSeconds: 15,
      })
    ).rejects.toThrow("主任务工具轮次上限");
    await expect(
      invokeSet({
        maxToolRounds: 200,
        maxSubagentToolRounds: 200,
        compactKeepRounds: 3,
        contextWarningThresholdPercent: "80%",
        mcpCallTimeoutSeconds: 30,
        mcpConnectTimeoutSeconds: 15,
      })
    ).rejects.toThrow("上下文告警阈值");
    // 票 07 两项：字符串数字同样按类型拒绝
    await expect(
      invokeSet({
        maxToolRounds: 200,
        maxSubagentToolRounds: 200,
        compactKeepRounds: 3,
        contextWarningThresholdPercent: 80,
        mcpCallTimeoutSeconds: "30",
        mcpConnectTimeoutSeconds: 15,
      })
    ).rejects.toThrow("MCP 工具调用超时");
    await expect(
      invokeSet({
        maxToolRounds: 200,
        maxSubagentToolRounds: 200,
        compactKeepRounds: 3,
        contextWarningThresholdPercent: 80,
        mcpCallTimeoutSeconds: 30,
        mcpConnectTimeoutSeconds: "15",
      })
    ).rejects.toThrow("MCP 连接超时");
    // 字符串数字（"200"）同样拒绝：强转放行缺口（"200" → 200 落盘）已封堵
    await expect(
      invokeSet({
        maxToolRounds: "200",
        maxSubagentToolRounds: 200,
        compactKeepRounds: 3,
        contextWarningThresholdPercent: 80,
        mcpCallTimeoutSeconds: 30,
        mcpConnectTimeoutSeconds: 15,
      })
    ).rejects.toThrow("主任务工具轮次上限");
    await expect(
      invokeSet({
        maxToolRounds: 200,
        maxSubagentToolRounds: 200,
        compactKeepRounds: 3,
        contextWarningThresholdPercent: "80",
        mcpCallTimeoutSeconds: 30,
        mcpConnectTimeoutSeconds: 15,
      })
    ).rejects.toThrow("上下文告警阈值");
    // 任务并发上限票 01：越界（1–8 外）与字符串数字同样拒绝
    await expect(
      invokeSet({
        maxToolRounds: 200,
        maxSubagentToolRounds: 200,
        compactKeepRounds: 3,
        contextWarningThresholdPercent: 80,
        mcpCallTimeoutSeconds: 30,
        mcpConnectTimeoutSeconds: 15,
        taskConcurrencyLimit: 0,
      })
    ).rejects.toThrow("任务并发上限");
    await expect(
      invokeSet({
        maxToolRounds: 200,
        maxSubagentToolRounds: 200,
        compactKeepRounds: 3,
        contextWarningThresholdPercent: 80,
        mcpCallTimeoutSeconds: 30,
        mcpConnectTimeoutSeconds: 15,
        taskConcurrencyLimit: "3",
      })
    ).rejects.toThrow("任务并发上限");
    // 非对象输入（同步抛出，同子代理 handler 先例）
    expect(() => bridge.handlers.get(IPC.agentSettings.set)!({}, 42)).toThrow(
      "输入不合法"
    );
    // 全部拒绝：onSaved 未触发
    expect(saved).toEqual([]);
  });

  it("preload 暴露 agentSettings 命名空间，转发同名 channel", async () => {
    await import("../../src/preload");
    const api = bridge.api!;
    expect("agentSettings" in api).toBe(true);

    await api.agentSettings!.get();
    expect(bridge.invoke).toHaveBeenLastCalledWith(IPC.agentSettings.get);
    await api.agentSettings!.set({
      maxToolRounds: 300,
      maxSubagentToolRounds: 400,
      compactKeepRounds: 5,
      contextWarningThresholdPercent: 70,
      mcpCallTimeoutSeconds: 90,
      mcpConnectTimeoutSeconds: 45,
      taskConcurrencyLimit: 6,
    });
    expect(bridge.invoke).toHaveBeenLastCalledWith(IPC.agentSettings.set, {
      maxToolRounds: 300,
      maxSubagentToolRounds: 400,
      compactKeepRounds: 5,
      contextWarningThresholdPercent: 70,
      mcpCallTimeoutSeconds: 90,
      mcpConnectTimeoutSeconds: 45,
      taskConcurrencyLimit: 6,
    });
  });
});
