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

  it("get/set 注册到 agent-settings:* 频道；set 落盘并回调 onSaved（内存缓存刷新点）", async () => {
    const { saved } = setup();

    expect(bridge.handlers.has(IPC.agentSettings.get)).toBe(true);
    expect(bridge.handlers.has(IPC.agentSettings.set)).toBe(true);

    // get：未配置返回默认值
    await expect(
      bridge.handlers.get(IPC.agentSettings.get)!({}, undefined)
    ).resolves.toEqual({ maxToolRounds: 200 });

    // set：合法值返回保存结果、落盘（经 store）并通知装配层刷新内存缓存
    await expect(
      bridge.handlers.get(IPC.agentSettings.set)!({}, { maxToolRounds: 500 })
    ).resolves.toEqual({ maxToolRounds: 500 });
    expect(saved).toEqual([{ maxToolRounds: 500 }]);
    await expect(
      bridge.handlers.get(IPC.agentSettings.get)!({}, undefined)
    ).resolves.toEqual({ maxToolRounds: 500 });
  });

  it("set：非法输入以中文异常抛回且不落盘（边界不信任渲染进程）", async () => {
    const { saved } = setup();

    // 越界/非整数 → store 校验拒绝
    await expect(
      bridge.handlers.get(IPC.agentSettings.set)!({}, { maxToolRounds: 9 })
    ).rejects.toThrow("工具轮次上限");
    // 非数字输入（渲染进程伪造）→ Number 归一后 NaN 同样拒绝
    await expect(
      bridge.handlers.get(IPC.agentSettings.set)!({}, { maxToolRounds: "abc" })
    ).rejects.toThrow("工具轮次上限");
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
    await api.agentSettings!.set({ maxToolRounds: 300 });
    expect(bridge.invoke).toHaveBeenLastCalledWith(IPC.agentSettings.set, {
      maxToolRounds: 300,
    });
  });
});
