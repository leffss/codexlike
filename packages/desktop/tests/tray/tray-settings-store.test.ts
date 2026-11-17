import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { createTraySettingsStore } from "../../src/tray/tray-settings-store";

/**
 * 托盘驻留设置存储（ADR 0025，GLOSSARY「托盘驻留」「开机启动」）：
 * 开机启动开关 + 驻留气泡只提示一次标志；损坏文件按默认处理。
 * 与 theme/terminal store 同构：真实落盘临时目录。
 */

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tray-settings-store-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createTraySettingsStore({ dir }) };
}

it("未配置时 get 返回默认值（开机启动关、气泡未展示）", async () => {
  const { store } = setup();
  expect(await store.get()).toEqual({
    launchAtLogin: false,
    residencyHintShown: false,
  });
});

it("set 部分字段合并落盘并返回完整设置；get 读回", async () => {
  const { dir, store } = setup();
  expect(await store.set({ launchAtLogin: true })).toEqual({
    launchAtLogin: true,
    residencyHintShown: false,
  });
  await store.set({ residencyHintShown: true });
  expect(await store.get()).toEqual({
    launchAtLogin: true,
    residencyHintShown: true,
  });
  expect(
    JSON.parse(readFileSync(join(dir, "tray-settings.json"), "utf8"))
  ).toEqual({ launchAtLogin: true, residencyHintShown: true });
});

it("损坏文件按默认值处理（不抛错）", async () => {
  const { dir, store } = setup();
  writeFileSync(join(dir, "tray-settings.json"), "{not json", "utf8");
  expect(await store.get()).toEqual({
    launchAtLogin: false,
    residencyHintShown: false,
  });
});

it("set 非布尔字段以中文异常拒绝且不落盘", async () => {
  const { dir, store } = setup();
  await store.set({});
  await expect(
    store.set({ launchAtLogin: "yes" as unknown as boolean })
  ).rejects.toThrow("launchAtLogin 必须是布尔值");
  expect(
    JSON.parse(readFileSync(join(dir, "tray-settings.json"), "utf8"))
  ).toEqual({ launchAtLogin: false, residencyHintShown: false });
});
