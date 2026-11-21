import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createBuiltinTools } from "../../src/tools/builtin";
import { createToolRegistry } from "../../src/tools/registry";
import type { TerminalSessionManager } from "../../src/terminal/manager";

/** 终端会话管理器最小 fake（builtin 装配面测试只关心工具注册形状） */
function fakeTerminalManager(): TerminalSessionManager {
  return {} as TerminalSessionManager;
}

describe("内置工具聚合（createBuiltinTools）", () => {
  it("提供六件核心工具，名称与权限类别符合 spec", () => {
    const tools = createBuiltinTools();
    expect(tools.map((tool) => [tool.name, tool.permission])).toEqual([
      ["read_file", "readonly"],
      ["write_file", "write"],
      ["apply_patch", "write"],
      ["glob", "readonly"],
      ["grep", "readonly"],
      ["run_terminal_command", "command"],
    ]);
  });

  it("六件工具全部可直接注册进注册表", () => {
    const registry = createToolRegistry();
    for (const tool of createBuiltinTools()) {
      registry.register(tool);
    }
    expect(registry.list()).toHaveLength(6);
  });

  it("每件工具都有给模型的描述与 object 参数 schema", () => {
    for (const tool of createBuiltinTools()) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.parameters.type).toBe("object");
      expect(
        Object.keys(tool.parameters.properties ?? {}).length
      ).toBeGreaterThan(0);
    }
  });

  it("注入终端会话管理器：四件终端会话工具追加进工具表（webSearch 同款可选注入）", () => {
    const tools = createBuiltinTools({
      terminalSessions: { manager: fakeTerminalManager() },
    });
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("spawn_terminal");
    expect(names).toContain("terminal_write");
    expect(names).toContain("terminal_read");
    expect(names).toContain("terminal_kill");
    expect(names).toContain("run_terminal_command");
  });

  it("不注入终端会话管理器：四件终端会话工具不注册（缺省不出现，模型无从误调）", () => {
    const names = createBuiltinTools().map((tool) => tool.name);
    expect(names).not.toContain("spawn_terminal");
    expect(names).not.toContain("terminal_write");
    expect(names).not.toContain("terminal_read");
    expect(names).not.toContain("terminal_kill");
  });

  it("终端超时注入透传给 run_terminal_command（执行设置票04）：注入默认值行为生效，描述不携带快照数字", async () => {
    const terminal = createBuiltinTools({
      env: { ...process.env },
      defaultTimeoutMs: 3_000,
      maxTimeoutMs: 600_000,
    }).find((tool) => tool.name === "run_terminal_command");
    expect(terminal).toBeDefined();
    // 工具描述不携带创建时刻的超时快照（code review 修复 5：设置可调后
    // 快照会过时），注入值改由行为透传验证
    expect(terminal!.description).not.toMatch(/超时默认 \d+ 秒/);
    expect(terminal!.description).not.toMatch(/上限 \d+ 秒/);
    // 未带 timeoutMs 的长命令按注入默认值 3 秒超时（而非工具层默认 30 秒），
    // 证明 createBuiltinTools → createTerminalTool 的注入透传不断
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-builtin-ws-"));
    const startedAt = Date.now();
    const result = await terminal!.execute(
      { command: "echo started; sleep 30" },
      {
        workspacePath: workspace,
        taskId: "builtin-terminal-test",
        approvalMode: "assist",
      }
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("started");
    expect(result.output).toContain("超时");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);
});
