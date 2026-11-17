import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createSubagentSettingsStore } from "../../src/subagents/subagent-settings-store";

/**
 * 工单 13：子代理全局设置存储（设置页「子代理模型 + 并发上限」的落点）。
 * 无敏感信息（Provider Profile 引用 + 数字），明文 JSON 即可；默认同主模型、并发 3。
 */
describe("subagent-settings-store", () => {
  function makeDir() {
    return mkdtempSync(join(tmpdir(), "codexlike-subagent-settings-"));
  }

  it("默认值：未配置时返回「同主模型 + 并发 3」，不落文件", async () => {
    const dir = makeDir();
    const store = createSubagentSettingsStore({ dir });
    expect(await store.get()).toEqual({
      providerProfileId: null,
      model: null,
      maxConcurrent: 3,
    });
  });

  it("set/get 往返：Profile 引用与并发上限持久化，重启（新 store 实例）后恢复", async () => {
    const dir = makeDir();
    const store = createSubagentSettingsStore({ dir });
    const saved = await store.set({
      providerProfileId: "profile-2",
      model: null,
      maxConcurrent: 5,
    });
    expect(saved).toEqual({
      providerProfileId: "profile-2",
      model: null,
      maxConcurrent: 5,
    });

    // 等价重启：同目录新实例读回
    const reopened = createSubagentSettingsStore({ dir });
    expect(await reopened.get()).toEqual({
      providerProfileId: "profile-2",
      model: null,
      maxConcurrent: 5,
    });

    // 落盘为普通 JSON（无敏感内容，无需加密）
    const raw = JSON.parse(
      readFileSync(join(dir, "subagent-settings.json"), "utf8")
    );
    expect(raw).toEqual({
      providerProfileId: "profile-2",
      model: null,
      maxConcurrent: 5,
    });
  });

  it("清除子代理模型引用：providerProfileId 置 null（同主模型），并发上限保留", async () => {
    const dir = makeDir();
    const store = createSubagentSettingsStore({ dir });
    await store.set({
      providerProfileId: "profile-2",
      model: null,
      maxConcurrent: 2,
    });
    const cleared = await store.set({
      providerProfileId: null,
      model: null,
      maxConcurrent: 2,
    });
    expect(cleared).toEqual({
      providerProfileId: null,
      model: null,
      maxConcurrent: 2,
    });
    expect(await store.get()).toEqual({
      providerProfileId: null,
      model: null,
      maxConcurrent: 2,
    });
  });

  it("并发上限校验：1-8 的整数；0、9、非整数、非数字均拒绝且不落盘", async () => {
    const dir = makeDir();
    const store = createSubagentSettingsStore({ dir });
    for (const bad of [0, 9, 1.5, Number.NaN]) {
      await expect(
        store.set({ providerProfileId: null, model: null, maxConcurrent: bad })
      ).rejects.toThrow("并发上限");
    }
    // 边界值合法
    expect(
      (
        await store.set({
          providerProfileId: null,
          model: null,
          maxConcurrent: 1,
        })
      ).maxConcurrent
    ).toBe(1);
    expect(
      (
        await store.set({
          providerProfileId: null,
          model: null,
          maxConcurrent: 8,
        })
      ).maxConcurrent
    ).toBe(8);
  });

  it("损坏/非法 JSON 文件：按默认值处理（不抛错）", async () => {
    const dir = makeDir();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "subagent-settings.json"), "{oops", "utf8");
    const store = createSubagentSettingsStore({ dir });
    expect(await store.get()).toEqual({
      providerProfileId: null,
      model: null,
      maxConcurrent: 3,
    });
  });

  it("越界的历史值读取时收敛到合法范围（防手改文件）", async () => {
    const dir = makeDir();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, "subagent-settings.json"),
      JSON.stringify({ providerProfileId: null, maxConcurrent: 99 }),
      "utf8"
    );
    const store = createSubagentSettingsStore({ dir });
    expect((await store.get()).maxConcurrent).toBe(8);
    rmSync(dir, { recursive: true, force: true });
  });

  it("模型级引用（票 02）：Profile + 具体模型持久化，重启后恢复", async () => {
    const dir = makeDir();
    const store = createSubagentSettingsStore({ dir });
    const saved = await store.set({
      providerProfileId: "profile-2",
      model: "glm-4.6",
      maxConcurrent: 3,
    });
    expect(saved).toEqual({
      providerProfileId: "profile-2",
      model: "glm-4.6",
      maxConcurrent: 3,
    });

    const reopened = createSubagentSettingsStore({ dir });
    expect(await reopened.get()).toEqual({
      providerProfileId: "profile-2",
      model: "glm-4.6",
      maxConcurrent: 3,
    });
  });

  it("未配置模型（旧数据/未选具体模型）读回 model 为 null：跟随主任务当前所用模型", async () => {
    const dir = makeDir();
    const { writeFileSync } = await import("node:fs");
    // 票 02 之前的落盘形态（无 model 字段）：读回 null，不抛错
    writeFileSync(
      join(dir, "subagent-settings.json"),
      JSON.stringify({ providerProfileId: "profile-2", maxConcurrent: 3 }),
      "utf8"
    );
    const store = createSubagentSettingsStore({ dir });
    expect(await store.get()).toEqual({
      providerProfileId: "profile-2",
      model: null,
      maxConcurrent: 3,
    });
  });

  it("清除模型引用回「同主模型」：providerProfileId 与 model 一并置 null", async () => {
    const dir = makeDir();
    const store = createSubagentSettingsStore({ dir });
    await store.set({
      providerProfileId: "profile-2",
      model: "glm-4.6",
      maxConcurrent: 2,
    });
    const cleared = await store.set({
      providerProfileId: null,
      model: null,
      maxConcurrent: 2,
    });
    expect(cleared).toEqual({
      providerProfileId: null,
      model: null,
      maxConcurrent: 2,
    });
  });

  it("model 类型非法时读回归一为 null（防手改文件写入非字符串）", async () => {
    const dir = makeDir();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, "subagent-settings.json"),
      JSON.stringify({
        providerProfileId: "profile-2",
        model: 42,
        maxConcurrent: 3,
      }),
      "utf8"
    );
    const store = createSubagentSettingsStore({ dir });
    expect((await store.get()).model).toBeNull();
  });
});
