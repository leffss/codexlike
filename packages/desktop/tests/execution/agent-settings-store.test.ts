import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createAgentSettingsStore } from "../../src/execution/agent-settings-store";

/**
 * 执行设置存储（ADR 0017，GLOSSARY「执行设置」）：`~/.codexlike/agent-settings.json`
 * 独立文件持久化，与现有各设置文件同形态（自研 JSON 读写、损坏按默认值处理）。
 * 两项参数（执行设置票 01/02）：主任务与子代理工具轮次上限
 * （各自默认 200，合法范围 10–1000，相互独立可调）。
 */
describe("agent-settings-store", () => {
  function makeDir() {
    return mkdtempSync(join(tmpdir(), "codexlike-agent-settings-"));
  }

  it("默认值：未配置时主任务与子代理轮次上限均为 200，不落文件", async () => {
    const dir = makeDir();
    const store = createAgentSettingsStore({ dir });
    expect(await store.get()).toEqual({
      maxToolRounds: 200,
      maxSubagentToolRounds: 200,
    });
  });

  it("set/get 往返：两项独立持久化，重启（新 store 实例）后恢复", async () => {
    const dir = makeDir();
    const store = createAgentSettingsStore({ dir });
    const saved = await store.set({ maxToolRounds: 500, maxSubagentToolRounds: 300 });
    expect(saved).toEqual({ maxToolRounds: 500, maxSubagentToolRounds: 300 });

    // 等价重启：同目录新实例读回
    const reopened = createAgentSettingsStore({ dir });
    expect(await reopened.get()).toEqual({
      maxToolRounds: 500,
      maxSubagentToolRounds: 300,
    });

    // 落盘为普通 JSON（无敏感内容，无需加密）
    const raw = JSON.parse(
      readFileSync(join(dir, "agent-settings.json"), "utf8")
    );
    expect(raw).toEqual({ maxToolRounds: 500, maxSubagentToolRounds: 300 });
  });

  it("set 校验主任务项：10–1000 的整数；9、1001、1.5、NaN 均拒绝且不落盘", async () => {
    const dir = makeDir();
    const store = createAgentSettingsStore({ dir });
    for (const bad of [9, 1001, 1.5, Number.NaN]) {
      await expect(
        store.set({ maxToolRounds: bad, maxSubagentToolRounds: 200 })
      ).rejects.toThrow("主任务工具轮次上限");
    }
    // 拒绝后未落盘：新实例仍读默认值
    expect(await createAgentSettingsStore({ dir }).get()).toEqual({
      maxToolRounds: 200,
      maxSubagentToolRounds: 200,
    });
    // 边界值合法
    expect(
      (await store.set({ maxToolRounds: 10, maxSubagentToolRounds: 200 }))
        .maxToolRounds
    ).toBe(10);
    expect(
      (await store.set({ maxToolRounds: 1000, maxSubagentToolRounds: 200 }))
        .maxToolRounds
    ).toBe(1000);
  });

  it("set 校验子代理项：与主任务项独立，非法拒绝且不落盘（票 02）", async () => {
    const dir = makeDir();
    const store = createAgentSettingsStore({ dir });
    for (const bad of [9, 1001, 1.5, Number.NaN]) {
      await expect(
        store.set({ maxToolRounds: 200, maxSubagentToolRounds: bad })
      ).rejects.toThrow("子代理工具轮次上限");
    }
    // 主任务项合法值不因子代理项非法而落盘（整体拒绝）
    expect(await createAgentSettingsStore({ dir }).get()).toEqual({
      maxToolRounds: 200,
      maxSubagentToolRounds: 200,
    });
    // 边界值合法，两项互不影响
    const saved = await store.set({ maxToolRounds: 200, maxSubagentToolRounds: 10 });
    expect(saved.maxSubagentToolRounds).toBe(10);
    expect(saved.maxToolRounds).toBe(200);
    expect((await store.set({ maxToolRounds: 200, maxSubagentToolRounds: 1000 })).maxSubagentToolRounds).toBe(1000);
  });

  it("损坏/非法 JSON 文件：两项均按默认值处理（不抛错）", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "agent-settings.json"), "{oops", "utf8");
    const store = createAgentSettingsStore({ dir });
    expect(await store.get()).toEqual({
      maxToolRounds: 200,
      maxSubagentToolRounds: 200,
    });
  });

  it("文件中的越界/非整数值：读取时逐项回退默认值（非法输入回退默认，防手改文件）", async () => {
    const dir = makeDir();
    for (const bad of [5, 2000, 2.5]) {
      writeFileSync(
        join(dir, "agent-settings.json"),
        JSON.stringify({ maxToolRounds: bad, maxSubagentToolRounds: bad }),
        "utf8"
      );
      const store = createAgentSettingsStore({ dir });
      expect(await store.get()).toEqual({
        maxToolRounds: 200,
        maxSubagentToolRounds: 200,
      });
    }
    // 旧格式文件（票 01 只有主任务项）：子代理项按默认补齐，主任务项保留
    writeFileSync(
      join(dir, "agent-settings.json"),
      JSON.stringify({ maxToolRounds: 500 }),
      "utf8"
    );
    const store = createAgentSettingsStore({ dir });
    expect(await store.get()).toEqual({
      maxToolRounds: 500,
      maxSubagentToolRounds: 200,
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
