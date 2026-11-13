import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLaunchStateStore } from "../../src/launch-state/launch-state-store";

/**
 * 启动现场 store（launch-state）：窗口 bounds + 最大化标志的单文件 JSON 持久化，
 * 形态照 theme-settings-store 先例（ENOENT → 未配置、损坏容错、字段非法按未配置）。
 */
const VALID_STATE = {
  bounds: { x: 120, y: 80, width: 900, height: 640 },
  maximized: false,
};

let tempDir: string;

function makeDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "codexlike-launch-state-"));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("launch-state-store", () => {
  it("未配置（无文件）返回 null；保存后恢复，重启（新实例）仍读到", async () => {
    const dir = makeDir();
    const store = createLaunchStateStore({ dir });
    expect(await store.get()).toBeNull();

    const maximizedState = { ...VALID_STATE, maximized: true };
    expect(await store.set(maximizedState)).toEqual(maximizedState);
    expect(await store.get()).toEqual(maximizedState);

    const reopened = createLaunchStateStore({ dir });
    expect(await reopened.get()).toEqual(maximizedState);
    // 落盘为 2 空格缩进 JSON（与各设置存储一致）
    expect(readFileSync(join(dir, "launch-state.json"), "utf8")).toBe(
      JSON.stringify(maximizedState, null, 2)
    );
  });

  it("set 拒绝非法形状：bounds 缺字段 / 非有限数字 / maximized 非布尔", async () => {
    const store = createLaunchStateStore({ dir: makeDir() });
    const cases = [
      { ...VALID_STATE, bounds: { x: 0, y: 0, width: 800 } },
      { ...VALID_STATE, bounds: { x: "a", y: 0, width: 800, height: 600 } },
      {
        ...VALID_STATE,
        bounds: { x: Number.NaN, y: 0, width: 800, height: 600 },
      },
      { ...VALID_STATE, maximized: "yes" },
    ];
    for (const input of cases) {
      await expect(store.set(input as never)).rejects.toThrow("启动现场");
    }
  });

  it("损坏文件按未配置（null）处理，不抛错", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "launch-state.json"), "{oops", "utf8");
    expect(await createLaunchStateStore({ dir }).get()).toBeNull();
  });

  it("文件存在但字段非法同样按未配置处理", async () => {
    const dir = makeDir();
    const cases = [
      JSON.stringify({ bounds: null, maximized: false }),
      JSON.stringify({
        bounds: { x: 0, y: 0, width: "wide", height: 600 },
        maximized: false,
      }),
      JSON.stringify({
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        maximized: 1,
      }),
    ];
    for (const raw of cases) {
      writeFileSync(join(dir, "launch-state.json"), raw, "utf8");
      expect(await createLaunchStateStore({ dir }).get()).toBeNull();
    }
  });

  it("父目录不存在时首次写入自建目录（CODING_STANDARDS 数据目录自建）", async () => {
    const dir = join(makeDir(), "nested", "codexlike");
    const store = createLaunchStateStore({ dir });
    expect(await store.set(VALID_STATE)).toEqual(VALID_STATE);
    expect(await createLaunchStateStore({ dir }).get()).toEqual(VALID_STATE);
  });
});
