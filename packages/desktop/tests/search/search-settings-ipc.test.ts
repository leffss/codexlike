import { beforeEach, expect, it, vi } from "vitest";

import { registerSearchSettingsHandlers } from "../../src/search/search-settings-ipc";
import type { SearchSettings } from "../../src/search/search-settings-store";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(name, handler),
  },
}));
beforeEach(() => handlers.clear());
const invoke = (name: string, ...args: unknown[]) =>
  handlers.get(`search-settings:${name}`)!({}, ...args);

it("设置读取重试成功同时恢复搜索能力，失败不伪装成默认配置", async () => {
  let broken = true;
  let active: SearchSettings | null = null;
  const configured: SearchSettings = {
    provider: "tavily",
    apiKey: "synthetic-key",
  };
  const get = async () => {
    if (broken) throw new Error("测试解密失败");
    return configured;
  };
  const refresh = async () => {
    active = null;
    const settings = await get();
    active = settings;
    return settings;
  };
  const save = vi.fn(async () => configured);
  registerSearchSettingsHandlers({ get, set: save }, refresh);
  await expect(invoke("get")).rejects.toThrow("测试解密失败");
  expect(active).toBeNull();
  broken = false;
  await expect(invoke("get")).resolves.toEqual(configured);
  expect(active).toEqual(configured);
  expect(save).not.toHaveBeenCalled();
});

it("保存与读取使用同一刷新结果，非法输入不改配置", async () => {
  let current: SearchSettings = { provider: "tavily", apiKey: "" };
  let active: SearchSettings | null = null;
  const set = vi.fn(async ({ apiKey }: { apiKey: string }) => {
    current = { provider: "tavily", apiKey };
    return current;
  });
  registerSearchSettingsHandlers(
    { get: async () => current, set },
    async () => {
      active = current;
      return current;
    }
  );
  expect(() => invoke("set", { apiKey: 1 })).toThrow("apiKey 必须是字符串");
  expect(set).not.toHaveBeenCalled();
  await expect(invoke("set", { apiKey: "new-key" })).resolves.toEqual({
    provider: "tavily",
    apiKey: "new-key",
  });
  expect(active).toEqual(current);
});
