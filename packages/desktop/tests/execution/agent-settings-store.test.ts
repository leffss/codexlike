import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createAgentSettingsStore } from "../../src/execution/agent-settings-store";

/**
 * 执行设置存储（ADR 0017，GLOSSARY「执行设置」）：`~/.codexlike/agent-settings.json`
 * 独立文件持久化，与现有各设置文件同形态（自研 JSON 读写、损坏按默认值处理）。
 * 七项参数（执行设置票 01/02/03/07 + 任务并发上限票 01）：主任务与子代理工具
 * 轮次上限（默认 200、范围 10–1000，相互独立可调）、压缩保留对话轮数（默认 3、
 * 范围 1–10）、上下文告警阈值（整数百分比呈现与存储，默认 80、范围 50–95）、
 * MCP 工具调用超时（默认 30、范围 5–300 秒）与 MCP 连接超时（默认 15、范围
 * 5–120 秒）、任务并发上限（默认 3、范围 1–8，GLOSSARY「任务并发上限」）。
 */
describe("agent-settings-store", () => {
  function makeDir() {
    return mkdtempSync(join(tmpdir(), "codexlike-agent-settings-"));
  }

  it("默认值：未配置时七项均为默认值，不落文件", async () => {
    const dir = makeDir();
    const store = createAgentSettingsStore({ dir });
    expect(await store.get()).toEqual({
      maxToolRounds: 200,
      maxSubagentToolRounds: 200,
      compactKeepRounds: 3,
      contextWarningThresholdPercent: 80,
      mcpCallTimeoutSeconds: 30,
      mcpConnectTimeoutSeconds: 15,
      taskConcurrencyLimit: 3,
    });
  });

  it("set/get 往返：七项独立持久化，重启（新 store 实例）后恢复", async () => {
    const dir = makeDir();
    const store = createAgentSettingsStore({ dir });
    const saved = await store.set({
      maxToolRounds: 500,
      maxSubagentToolRounds: 300,
      compactKeepRounds: 5,
      contextWarningThresholdPercent: 65,
      mcpCallTimeoutSeconds: 120,
      mcpConnectTimeoutSeconds: 60,
      taskConcurrencyLimit: 6,
    });
    expect(saved).toEqual({
      maxToolRounds: 500,
      maxSubagentToolRounds: 300,
      compactKeepRounds: 5,
      contextWarningThresholdPercent: 65,
      mcpCallTimeoutSeconds: 120,
      mcpConnectTimeoutSeconds: 60,
      taskConcurrencyLimit: 6,
    });

    // 等价重启：同目录新实例读回
    const reopened = createAgentSettingsStore({ dir });
    expect(await reopened.get()).toEqual({
      maxToolRounds: 500,
      maxSubagentToolRounds: 300,
      compactKeepRounds: 5,
      contextWarningThresholdPercent: 65,
      mcpCallTimeoutSeconds: 120,
      mcpConnectTimeoutSeconds: 60,
      taskConcurrencyLimit: 6,
    });

    // 落盘为普通 JSON（无敏感内容，无需加密）
    const raw = JSON.parse(
      readFileSync(join(dir, "agent-settings.json"), "utf8")
    );
    expect(raw).toEqual({
      maxToolRounds: 500,
      maxSubagentToolRounds: 300,
      compactKeepRounds: 5,
      contextWarningThresholdPercent: 65,
      mcpCallTimeoutSeconds: 120,
      mcpConnectTimeoutSeconds: 60,
      taskConcurrencyLimit: 6,
    });
  });

  it("set 校验主任务项：10–1000 的整数；9、1001、1.5、NaN 均拒绝且不落盘", async () => {
    const dir = makeDir();
    const store = createAgentSettingsStore({ dir });
    for (const bad of [9, 1001, 1.5, Number.NaN]) {
      await expect(
        store.set({
          maxToolRounds: bad,
          maxSubagentToolRounds: 200,
          compactKeepRounds: 3,
          contextWarningThresholdPercent: 80,
          mcpCallTimeoutSeconds: 30,
          mcpConnectTimeoutSeconds: 15,
          taskConcurrencyLimit: 3,
        })
      ).rejects.toThrow("主任务工具轮次上限");
    }
    // 拒绝后未落盘：新实例仍读默认值
    expect(await createAgentSettingsStore({ dir }).get()).toEqual({
      maxToolRounds: 200,
      maxSubagentToolRounds: 200,
      compactKeepRounds: 3,
      contextWarningThresholdPercent: 80,
      mcpCallTimeoutSeconds: 30,
      mcpConnectTimeoutSeconds: 15,
      taskConcurrencyLimit: 3,
    });
    // 边界值合法
    expect(
      (
        await store.set({
          maxToolRounds: 10,
          maxSubagentToolRounds: 200,
          compactKeepRounds: 3,
          contextWarningThresholdPercent: 80,
          mcpCallTimeoutSeconds: 30,
          mcpConnectTimeoutSeconds: 15,
          taskConcurrencyLimit: 3,
        })
      ).maxToolRounds
    ).toBe(10);
    expect(
      (
        await store.set({
          maxToolRounds: 1000,
          maxSubagentToolRounds: 200,
          compactKeepRounds: 3,
          contextWarningThresholdPercent: 80,
          mcpCallTimeoutSeconds: 30,
          mcpConnectTimeoutSeconds: 15,
          taskConcurrencyLimit: 3,
        })
      ).maxToolRounds
    ).toBe(1000);
  });

  it("set 校验子代理项：与主任务项独立，非法拒绝且不落盘（票 02）", async () => {
    const dir = makeDir();
    const store = createAgentSettingsStore({ dir });
    for (const bad of [9, 1001, 1.5, Number.NaN]) {
      await expect(
        store.set({
          maxToolRounds: 200,
          maxSubagentToolRounds: bad,
          compactKeepRounds: 3,
          contextWarningThresholdPercent: 80,
          mcpCallTimeoutSeconds: 30,
          mcpConnectTimeoutSeconds: 15,
          taskConcurrencyLimit: 3,
        })
      ).rejects.toThrow("子代理工具轮次上限");
    }
    // 主任务项合法值不因子代理项非法而落盘（整体拒绝）
    expect(await createAgentSettingsStore({ dir }).get()).toEqual({
      maxToolRounds: 200,
      maxSubagentToolRounds: 200,
      compactKeepRounds: 3,
      contextWarningThresholdPercent: 80,
      mcpCallTimeoutSeconds: 30,
      mcpConnectTimeoutSeconds: 15,
      taskConcurrencyLimit: 3,
    });
    // 边界值合法，两项互不影响
    const saved = await store.set({
      maxToolRounds: 200,
      maxSubagentToolRounds: 10,
      compactKeepRounds: 3,
      contextWarningThresholdPercent: 80,
      mcpCallTimeoutSeconds: 30,
      mcpConnectTimeoutSeconds: 15,
      taskConcurrencyLimit: 3,
    });
    expect(saved.maxSubagentToolRounds).toBe(10);
    expect(saved.maxToolRounds).toBe(200);
    expect(
      (
        await store.set({
          maxToolRounds: 200,
          maxSubagentToolRounds: 1000,
          compactKeepRounds: 3,
          contextWarningThresholdPercent: 80,
          mcpCallTimeoutSeconds: 30,
          mcpConnectTimeoutSeconds: 15,
          taskConcurrencyLimit: 3,
        })
      ).maxSubagentToolRounds
    ).toBe(1000);
  });

  it("set 校验压缩保留轮数（票 03）：1–10 的整数；0、11、1.5、NaN 拒绝且不落盘", async () => {
    const dir = makeDir();
    const store = createAgentSettingsStore({ dir });
    for (const bad of [0, 11, 1.5, Number.NaN]) {
      await expect(
        store.set({
          maxToolRounds: 200,
          maxSubagentToolRounds: 200,
          compactKeepRounds: bad,
          contextWarningThresholdPercent: 80,
          mcpCallTimeoutSeconds: 30,
          mcpConnectTimeoutSeconds: 15,
          taskConcurrencyLimit: 3,
        })
      ).rejects.toThrow("压缩保留对话轮数");
    }
    // 整体拒绝：轮次项合法值也不落盘
    expect(await createAgentSettingsStore({ dir }).get()).toEqual({
      maxToolRounds: 200,
      maxSubagentToolRounds: 200,
      compactKeepRounds: 3,
      contextWarningThresholdPercent: 80,
      mcpCallTimeoutSeconds: 30,
      mcpConnectTimeoutSeconds: 15,
      taskConcurrencyLimit: 3,
    });
    // 边界值合法
    expect(
      (
        await store.set({
          maxToolRounds: 200,
          maxSubagentToolRounds: 200,
          compactKeepRounds: 1,
          contextWarningThresholdPercent: 80,
          mcpCallTimeoutSeconds: 30,
          mcpConnectTimeoutSeconds: 15,
          taskConcurrencyLimit: 3,
        })
      ).compactKeepRounds
    ).toBe(1);
    expect(
      (
        await store.set({
          maxToolRounds: 200,
          maxSubagentToolRounds: 200,
          compactKeepRounds: 10,
          contextWarningThresholdPercent: 80,
          mcpCallTimeoutSeconds: 30,
          mcpConnectTimeoutSeconds: 15,
          taskConcurrencyLimit: 3,
        })
      ).compactKeepRounds
    ).toBe(10);
  });

  it("set 校验上下文告警阈值（票 03）：50–95 的整数百分比；49、96、80.5、NaN 拒绝且不落盘", async () => {
    const dir = makeDir();
    const store = createAgentSettingsStore({ dir });
    for (const bad of [49, 96, 80.5, Number.NaN]) {
      await expect(
        store.set({
          maxToolRounds: 200,
          maxSubagentToolRounds: 200,
          compactKeepRounds: 3,
          contextWarningThresholdPercent: bad,
          mcpCallTimeoutSeconds: 30,
          mcpConnectTimeoutSeconds: 15,
          taskConcurrencyLimit: 3,
        })
      ).rejects.toThrow("上下文告警阈值");
    }
    // 整体拒绝：其余项合法值也不落盘
    expect(await createAgentSettingsStore({ dir }).get()).toEqual({
      maxToolRounds: 200,
      maxSubagentToolRounds: 200,
      compactKeepRounds: 3,
      contextWarningThresholdPercent: 80,
      mcpCallTimeoutSeconds: 30,
      mcpConnectTimeoutSeconds: 15,
      taskConcurrencyLimit: 3,
    });
    // 边界值合法
    expect(
      (
        await store.set({
          maxToolRounds: 200,
          maxSubagentToolRounds: 200,
          compactKeepRounds: 3,
          contextWarningThresholdPercent: 50,
          mcpCallTimeoutSeconds: 30,
          mcpConnectTimeoutSeconds: 15,
          taskConcurrencyLimit: 3,
        })
      ).contextWarningThresholdPercent
    ).toBe(50);
    expect(
      (
        await store.set({
          maxToolRounds: 200,
          maxSubagentToolRounds: 200,
          compactKeepRounds: 3,
          contextWarningThresholdPercent: 95,
          mcpCallTimeoutSeconds: 30,
          mcpConnectTimeoutSeconds: 15,
          taskConcurrencyLimit: 3,
        })
      ).contextWarningThresholdPercent
    ).toBe(95);
  });

  it("set 校验 MCP 工具调用超时（票 07）：5–300 的整数秒；4、301、10.5、NaN 拒绝且不落盘", async () => {
    const dir = makeDir();
    const store = createAgentSettingsStore({ dir });
    for (const bad of [4, 301, 10.5, Number.NaN]) {
      await expect(
        store.set({
          maxToolRounds: 200,
          maxSubagentToolRounds: 200,
          compactKeepRounds: 3,
          contextWarningThresholdPercent: 80,
          mcpCallTimeoutSeconds: bad,
          mcpConnectTimeoutSeconds: 15,
          taskConcurrencyLimit: 3,
        })
      ).rejects.toThrow("MCP 工具调用超时");
    }
    // 整体拒绝：其余项合法值也不落盘
    expect(await createAgentSettingsStore({ dir }).get()).toEqual({
      maxToolRounds: 200,
      maxSubagentToolRounds: 200,
      compactKeepRounds: 3,
      contextWarningThresholdPercent: 80,
      mcpCallTimeoutSeconds: 30,
      mcpConnectTimeoutSeconds: 15,
      taskConcurrencyLimit: 3,
    });
    // 边界值合法
    expect(
      (
        await store.set({
          maxToolRounds: 200,
          maxSubagentToolRounds: 200,
          compactKeepRounds: 3,
          contextWarningThresholdPercent: 80,
          mcpCallTimeoutSeconds: 5,
          mcpConnectTimeoutSeconds: 15,
          taskConcurrencyLimit: 3,
        })
      ).mcpCallTimeoutSeconds
    ).toBe(5);
    expect(
      (
        await store.set({
          maxToolRounds: 200,
          maxSubagentToolRounds: 200,
          compactKeepRounds: 3,
          contextWarningThresholdPercent: 80,
          mcpCallTimeoutSeconds: 300,
          mcpConnectTimeoutSeconds: 15,
          taskConcurrencyLimit: 3,
        })
      ).mcpCallTimeoutSeconds
    ).toBe(300);
  });

  it("set 校验 MCP 连接超时（票 07）：5–120 的整数秒；4、121、7.5、NaN 拒绝且不落盘", async () => {
    const dir = makeDir();
    const store = createAgentSettingsStore({ dir });
    for (const bad of [4, 121, 7.5, Number.NaN]) {
      await expect(
        store.set({
          maxToolRounds: 200,
          maxSubagentToolRounds: 200,
          compactKeepRounds: 3,
          contextWarningThresholdPercent: 80,
          mcpCallTimeoutSeconds: 30,
          mcpConnectTimeoutSeconds: bad,
          taskConcurrencyLimit: 3,
        })
      ).rejects.toThrow("MCP 连接超时");
    }
    // 整体拒绝：其余项合法值也不落盘
    expect(await createAgentSettingsStore({ dir }).get()).toEqual({
      maxToolRounds: 200,
      maxSubagentToolRounds: 200,
      compactKeepRounds: 3,
      contextWarningThresholdPercent: 80,
      mcpCallTimeoutSeconds: 30,
      mcpConnectTimeoutSeconds: 15,
      taskConcurrencyLimit: 3,
    });
    // 边界值合法，与调用超时相互独立
    const saved = await store.set({
      maxToolRounds: 200,
      maxSubagentToolRounds: 200,
      compactKeepRounds: 3,
      contextWarningThresholdPercent: 80,
      mcpCallTimeoutSeconds: 30,
      mcpConnectTimeoutSeconds: 5,
      taskConcurrencyLimit: 3,
    });
    expect(saved.mcpConnectTimeoutSeconds).toBe(5);
    expect(saved.mcpCallTimeoutSeconds).toBe(30);
    expect(
      (
        await store.set({
          maxToolRounds: 200,
          maxSubagentToolRounds: 200,
          compactKeepRounds: 3,
          contextWarningThresholdPercent: 80,
          mcpCallTimeoutSeconds: 30,
          mcpConnectTimeoutSeconds: 120,
          taskConcurrencyLimit: 3,
        })
      ).mcpConnectTimeoutSeconds
    ).toBe(120);
  });

  it("set 校验任务并发上限（任务并发上限票 01）：1–8 的整数；0、9、1.5、NaN 拒绝且不落盘", async () => {
    const dir = makeDir();
    const store = createAgentSettingsStore({ dir });
    for (const bad of [0, 9, 1.5, Number.NaN]) {
      await expect(
        store.set({
          maxToolRounds: 200,
          maxSubagentToolRounds: 200,
          compactKeepRounds: 3,
          contextWarningThresholdPercent: 80,
          mcpCallTimeoutSeconds: 30,
          mcpConnectTimeoutSeconds: 15,
          taskConcurrencyLimit: bad,
        })
      ).rejects.toThrow("任务并发上限");
    }
    // 整体拒绝：其余项合法值也不落盘
    expect(await createAgentSettingsStore({ dir }).get()).toEqual({
      maxToolRounds: 200,
      maxSubagentToolRounds: 200,
      compactKeepRounds: 3,
      contextWarningThresholdPercent: 80,
      mcpCallTimeoutSeconds: 30,
      mcpConnectTimeoutSeconds: 15,
      taskConcurrencyLimit: 3,
    });
    // 边界值合法，与其余六项相互独立
    const saved = await store.set({
      maxToolRounds: 200,
      maxSubagentToolRounds: 200,
      compactKeepRounds: 3,
      contextWarningThresholdPercent: 80,
      mcpCallTimeoutSeconds: 30,
      mcpConnectTimeoutSeconds: 15,
      taskConcurrencyLimit: 1,
    });
    expect(saved.taskConcurrencyLimit).toBe(1);
    expect(
      (
        await store.set({
          maxToolRounds: 200,
          maxSubagentToolRounds: 200,
          compactKeepRounds: 3,
          contextWarningThresholdPercent: 80,
          mcpCallTimeoutSeconds: 30,
          mcpConnectTimeoutSeconds: 15,
          taskConcurrencyLimit: 8,
        })
      ).taskConcurrencyLimit
    ).toBe(8);
  });

  it("损坏/非法 JSON 文件：七项均按默认值处理（不抛错）", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "agent-settings.json"), "{oops", "utf8");
    const store = createAgentSettingsStore({ dir });
    expect(await store.get()).toEqual({
      maxToolRounds: 200,
      maxSubagentToolRounds: 200,
      compactKeepRounds: 3,
      contextWarningThresholdPercent: 80,
      mcpCallTimeoutSeconds: 30,
      mcpConnectTimeoutSeconds: 15,
      taskConcurrencyLimit: 3,
    });
  });

  it("文件中的越界/非整数值：读取时逐项回退默认值（非法输入回退默认，防手改文件）", async () => {
    const dir = makeDir();
    // 轮次项越界（票 01/02 既有范围）、票 03 两项与票 07 两项越界、任务并发上限
    // 越界（0 在 1–8 外），逐项独立回退
    for (const bad of [5, 2000, 2.5]) {
      writeFileSync(
        join(dir, "agent-settings.json"),
        JSON.stringify({
          maxToolRounds: bad,
          maxSubagentToolRounds: bad,
          compactKeepRounds: 0,
          contextWarningThresholdPercent: 96,
          mcpCallTimeoutSeconds: 2,
          mcpConnectTimeoutSeconds: 500,
          taskConcurrencyLimit: 0,
        }),
        "utf8"
      );
      const store = createAgentSettingsStore({ dir });
      expect(await store.get()).toEqual({
        maxToolRounds: 200,
        maxSubagentToolRounds: 200,
        compactKeepRounds: 3,
        contextWarningThresholdPercent: 80,
        mcpCallTimeoutSeconds: 30,
        mcpConnectTimeoutSeconds: 15,
        taskConcurrencyLimit: 3,
      });
    }
    // 旧格式文件（票 01/02 只有轮次两项）：后续各项按默认补齐，轮次项保留
    writeFileSync(
      join(dir, "agent-settings.json"),
      JSON.stringify({ maxToolRounds: 500, maxSubagentToolRounds: 300 }),
      "utf8"
    );
    const store = createAgentSettingsStore({ dir });
    expect(await store.get()).toEqual({
      maxToolRounds: 500,
      maxSubagentToolRounds: 300,
      compactKeepRounds: 3,
      contextWarningThresholdPercent: 80,
      mcpCallTimeoutSeconds: 30,
      mcpConnectTimeoutSeconds: 15,
      taskConcurrencyLimit: 3,
    });
    // 票 07 之前的格式（四字段）：MCP 两项按默认补齐，其余保留
    writeFileSync(
      join(dir, "agent-settings.json"),
      JSON.stringify({
        maxToolRounds: 500,
        maxSubagentToolRounds: 300,
        compactKeepRounds: 7,
        contextWarningThresholdPercent: 60,
      }),
      "utf8"
    );
    expect(await createAgentSettingsStore({ dir }).get()).toEqual({
      maxToolRounds: 500,
      maxSubagentToolRounds: 300,
      compactKeepRounds: 7,
      contextWarningThresholdPercent: 60,
      mcpCallTimeoutSeconds: 30,
      mcpConnectTimeoutSeconds: 15,
      taskConcurrencyLimit: 3,
    });
    // 任务并发上限票 01 之前的格式（六字段）：并发上限按默认补齐，其余保留
    writeFileSync(
      join(dir, "agent-settings.json"),
      JSON.stringify({
        maxToolRounds: 500,
        maxSubagentToolRounds: 300,
        compactKeepRounds: 7,
        contextWarningThresholdPercent: 60,
        mcpCallTimeoutSeconds: 90,
        mcpConnectTimeoutSeconds: 45,
      }),
      "utf8"
    );
    expect(await createAgentSettingsStore({ dir }).get()).toEqual({
      maxToolRounds: 500,
      maxSubagentToolRounds: 300,
      compactKeepRounds: 7,
      contextWarningThresholdPercent: 60,
      mcpCallTimeoutSeconds: 90,
      mcpConnectTimeoutSeconds: 45,
      taskConcurrencyLimit: 3,
    });
    // 合法新值保留、非法旧值回退可并存（逐项收敛）
    writeFileSync(
      join(dir, "agent-settings.json"),
      JSON.stringify({
        maxToolRounds: 500,
        maxSubagentToolRounds: 300,
        compactKeepRounds: 7,
        contextWarningThresholdPercent: 60,
        mcpCallTimeoutSeconds: 90,
        mcpConnectTimeoutSeconds: 45,
        taskConcurrencyLimit: 6,
      }),
      "utf8"
    );
    expect(await createAgentSettingsStore({ dir }).get()).toEqual({
      maxToolRounds: 500,
      maxSubagentToolRounds: 300,
      compactKeepRounds: 7,
      contextWarningThresholdPercent: 60,
      mcpCallTimeoutSeconds: 90,
      mcpConnectTimeoutSeconds: 45,
      taskConcurrencyLimit: 6,
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
