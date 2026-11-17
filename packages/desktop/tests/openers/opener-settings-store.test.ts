import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOpenerSettingsStore,
  isOpenerId,
  OPENER_IDS,
  OPENER_LABELS,
  resolveDefaultOpener,
  type OpenerSettings,
} from "../../src/openers/opener-settings-store";

/**
 * 工作区打开器设置（GLOSSARY「工作区打开器」）：默认打开器一项的 store
 * 持久化、非法/损坏回退、生效默认折算（保存项已卸载时回退 explorer）。
 */
let tempDir: string;

function makeDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "codexlike-opener-settings-"));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("opener-settings-store", () => {
  it("未配置（无文件）返回默认 explorer，不落文件", async () => {
    const dir = makeDir();
    const store = createOpenerSettingsStore({ dir });
    expect(await store.get()).toEqual({ defaultId: "explorer" });
    expect(() =>
      readFileSync(join(dir, "opener-settings.json"), "utf8")
    ).toThrow();
  });

  it("set/get 往返：默认打开器持久化，重启（新实例）仍读到", async () => {
    const dir = makeDir();
    const store = createOpenerSettingsStore({ dir });
    expect(await store.set({ defaultId: "vscode" })).toEqual({
      defaultId: "vscode",
    });
    expect(
      JSON.parse(readFileSync(join(dir, "opener-settings.json"), "utf8"))
    ).toEqual({ defaultId: "vscode" });
    // 重启：同一目录新实例读到保存值
    expect(await createOpenerSettingsStore({ dir }).get()).toEqual({
      defaultId: "vscode",
    });
  });

  it("父目录不存在时 set 自建目录落盘（writeJsonFile 的 mkdir 兜底）", async () => {
    const dir = join(makeDir(), "nested", "settings");
    const store = createOpenerSettingsStore({ dir });
    expect(await store.set({ defaultId: "webstorm" })).toEqual({
      defaultId: "webstorm",
    });
    expect(
      JSON.parse(readFileSync(join(dir, "opener-settings.json"), "utf8"))
    ).toEqual({ defaultId: "webstorm" });
  });

  it("set 拒绝未知 id；损坏文件与非法值读取回退 explorer", async () => {
    const dir = makeDir();
    const store = createOpenerSettingsStore({ dir });
    await expect(
      store.set({ defaultId: "notepad" } as unknown as OpenerSettings)
    ).rejects.toThrow(/默认打开器/);
    writeFileSync(join(dir, "opener-settings.json"), "{broken", "utf8");
    expect(await store.get()).toEqual({ defaultId: "explorer" });
    writeFileSync(
      join(dir, "opener-settings.json"),
      JSON.stringify({ defaultId: "sublime" }),
      "utf8"
    );
    expect(await store.get()).toEqual({ defaultId: "explorer" });
  });
});

describe("resolveDefaultOpener", () => {
  it("保存项在可用列表中原样生效；不在（已卸载）回退 explorer", () => {
    expect(resolveDefaultOpener("pycharm", ["explorer", "pycharm"])).toBe(
      "pycharm"
    );
    expect(resolveDefaultOpener("pycharm", ["explorer", "vscode"])).toBe(
      "explorer"
    );
  });
});

describe("isOpenerId", () => {
  it("枚举成员放行，其余拒绝", () => {
    for (const id of [
      "explorer",
      "terminal",
      "vscode",
      "pycharm",
      "intellij",
      "webstorm",
    ])
      expect(isOpenerId(id)).toBe(true);
    expect(isOpenerId("notepad")).toBe(false);
    expect(isOpenerId(null)).toBe(false);
  });

  it("OPENER_IDS 顺序即下拉菜单顺序：terminal 紧随 explorer（资源管理器下面）且带中文标签", () => {
    expect(OPENER_IDS.slice(0, 2)).toEqual(["explorer", "terminal"]);
    expect(OPENER_LABELS.terminal).toBe("终端");
  });
});
