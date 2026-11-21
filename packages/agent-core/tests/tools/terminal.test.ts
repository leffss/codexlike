import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTerminalTool } from "../../src/tools/terminal";
import type { ToolExecutionContext } from "../../src/tools/types";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
  workspaces.push(workspace);
  return workspace;
}

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) {
    // 超时/abort 的 taskkill 异步退出，不能用同步删除阻塞其收尾事件。
    await rm(workspace, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

function context(workspacePath: string): ToolExecutionContext {
  return {
    workspacePath,
    taskId: "unit-test-task",
    approvalMode: "assist",
  };
}

/** 与生产宿主同构：传完整 process.env，工具层做白名单过滤 */
const baseEnv = { ...process.env };

describe.skipIf(process.platform !== "win32")(
  "run_terminal_command 真实 Windows cmd 参数",
  () => {
    it("带空格绝对路径、带引号参数与 cmd 元字符按原命令执行", async () => {
      const workspace = makeWorkspace();
      const directory = join(workspace, "space directory");
      mkdirSync(directory);
      const file = join(directory, "quoted & value.txt");
      writeFileSync(file, "space-path-ok");
      const cmd = createTerminalTool({ env: baseEnv, shell: "cmd" });

      const result = await cmd.execute(
        {
          command: `type "${file}" && echo quoted ^& literal && (echo piped | findstr piped)`,
        },
        context(workspace)
      );

      expect(result.isError, result.output).toBe(false);
      expect(result.output).toContain("space-path-ok");
      expect(result.output).toContain("quoted & literal");
    });

    it("带空格可执行程序路径和参数保留双引号、空格、元字符", async () => {
      const workspace = makeWorkspace();
      const directory = join(workspace, "program files");
      mkdirSync(directory);
      const executable = join(directory, "node copy.exe");
      copyFileSync(process.execPath, executable);
      const script = join(directory, "print args.cjs");
      writeFileSync(
        script,
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n"
      );
      const cmd = createTerminalTool({ env: baseEnv, shell: "cmd" });

      const result = await cmd.execute(
        {
          command: `"${executable}" "${script}" "hello world" "a&b|c" "say \\"hi\\""`,
        },
        context(workspace)
      );

      expect(result.isError).toBe(false);
      expect(JSON.parse(result.output)).toEqual([
        "hello world",
        "a&b|c",
        'say "hi"',
      ]);
    });
  }
);

describe("run_terminal_command 工具（默认 Git Bash）", () => {
  const tool = createTerminalTool({ env: baseEnv });

  it("基础命令执行并返回 stdout", async () => {
    const workspace = makeWorkspace();
    const result = await tool.execute(
      { command: "echo hello-from-bash" },
      context(workspace)
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain("hello-from-bash");
  }, 15_000);

  it("POSIX 命令组合（ls、&&、管道）在 Windows 上经 Git Bash 正常执行", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "a.txt"), "x");
    writeFileSync(join(workspace, "b.txt"), "y");

    const result = await tool.execute(
      { command: "ls *.txt | sort && echo done" },
      context(workspace)
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain("a.txt");
    expect(result.output).toContain("b.txt");
    expect(result.output).toContain("done");
  }, 15_000);

  it("cwd 默认为工作区（pwd 落在工作区内），stderr 单独成节，非零退出码标记为失败", async () => {
    const workspace = makeWorkspace();
    const pwd = await tool.execute({ command: "pwd" }, context(workspace));
    expect(pwd.isError).toBe(false);
    expect(pwd.output.toLowerCase()).toContain("codexlike-ws-");

    const failing = await tool.execute(
      { command: "echo Oops >&2; exit 3" },
      context(workspace)
    );
    expect(failing.isError).toBe(true);
    expect(failing.output).toContain("Oops");
    expect(failing.output).toContain("3");
  }, 15_000);

  it("超时：强制终止并返回已收集输出与超时标记", async () => {
    const workspace = makeWorkspace();
    // 超时窗口 3000ms：满载并发下 Git Bash 启动 + echo 输出采集可超 500ms，
    // 窗口过短时 echo 尚未产出即被杀（2026-11-11 pre-commit 满载 flaky 实证）。
    // 3000ms 内 echo（毫秒级）稳定产出，sleep 30 保证仍走到强制终止。
    const result = await tool.execute(
      { command: "echo started; sleep 30", timeoutMs: 3000 },
      context(workspace)
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("started");
    expect(result.output).toContain("超时");
  }, 15_000);

  it("超长输出被截断并带标记", async () => {
    const workspace = makeWorkspace();
    const small = createTerminalTool({ env: baseEnv, maxOutputLength: 200 });
    const result = await small.execute(
      { command: "seq 1 20000" },
      context(workspace)
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain("[输出已截断");
    expect(result.output.length).toBeLessThan(1_000);
  }, 15_000);

  it("环境变量白名单：PATH 等基础项可用，未列名变量不透传", async () => {
    const workspace = makeWorkspace();
    const withSecret = { ...baseEnv, CODEXLIKE_TEST_SECRET: "do-not-leak" };
    const strict = createTerminalTool({ env: withSecret });

    const pathOk = await strict.execute(
      { command: "printenv PATH" },
      context(workspace)
    );
    expect(pathOk.isError).toBe(false);
    expect(pathOk.output.trim().length).toBeGreaterThan(0);

    const leak = await strict.execute(
      {
        command:
          "printenv CODEXLIKE_TEST_SECRET && echo LEAKED || echo NOT_LEAKED",
      },
      context(workspace)
    );
    expect(leak.output).toContain("NOT_LEAKED");
    expect(leak.output).not.toContain("do-not-leak");
  }, 15_000);

  it("命令中的 Windows 反斜杠绝对路径在工具层转换为 POSIX（bash 可直接使用）", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "note.txt"), "path-conversion-works");

    const result = await tool.execute(
      { command: `cat "${workspace}\\note.txt"` },
      context(workspace)
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain("path-conversion-works");
  }, 15_000);

  it("cwd 参数限定子目录；越界 cwd 被拒", async () => {
    const workspace = makeWorkspace();
    const inSub = await tool.execute(
      { command: "pwd", cwd: "." },
      context(workspace)
    );
    expect(inSub.isError).toBe(false);

    const escape = await tool.execute(
      { command: "pwd", cwd: ".." },
      context(workspace)
    );
    expect(escape.isError).toBe(true);
    expect(escape.output).toContain("路径越界");
  }, 15_000);

  it("可配置 PowerShell：命令经 powershell.exe 执行", async () => {
    if (process.platform !== "win32") return; // Windows 优先（spec），其它平台跳过
    const workspace = makeWorkspace();
    const powershell = createTerminalTool({
      env: baseEnv,
      shell: "powershell",
    });
    const result = await powershell.execute(
      { command: "Write-Output hello-from-ps" },
      context(workspace)
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain("hello-from-ps");
  }, 30_000);

  it("shell 支持函数形态逐次解析：中途切换对后续命令生效（设置页保存后无需重启工具实例）", async () => {
    if (process.platform !== "win32") return; // PowerShell/cmd 仅 Windows
    const workspace = makeWorkspace();
    let current: "git-bash" | "cmd" = "git-bash";
    const tool = createTerminalTool({ env: baseEnv, shell: () => current });

    // Git Bash：POSIX 语法可用
    const viaBash = await tool.execute(
      { command: "echo from-bash && cat /dev/null" },
      context(workspace)
    );
    expect(viaBash.isError).toBe(false);
    expect(viaBash.output).toContain("from-bash");

    // 切到 cmd：同一工具实例的下一次执行立即用 cmd（POSIX 语法不可用，cmd 语法 echo 可用）
    current = "cmd";
    const viaCmd = await tool.execute(
      { command: "echo from-cmd" },
      context(workspace)
    );
    expect(viaCmd.isError).toBe(false);
    expect(viaCmd.output).toContain("from-cmd");
  }, 30_000);

  it("超时上限夹紧模型请求的 timeoutMs（maxTimeoutMs 为硬上限）", async () => {
    const workspace = makeWorkspace();
    // 默认 30s，但上限注入为 3s：模型请求 10s 也只跑 3s
    const capped = createTerminalTool({
      env: baseEnv,
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 3_000,
    });
    const startedAt = Date.now();
    const result = await capped.execute(
      { command: "echo started; sleep 30", timeoutMs: 10_000 },
      context(workspace)
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("超时");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);

  it("注入默认超时生效：未带 timeoutMs 的长命令按注入值超时", async () => {
    const workspace = makeWorkspace();
    const tool = createTerminalTool({ env: baseEnv, defaultTimeoutMs: 3_000 });
    const startedAt = Date.now();
    const result = await tool.execute(
      { command: "echo started; sleep 30" },
      context(workspace)
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("started");
    expect(result.output).toContain("超时");
    // 按注入值 3s 超时，而不是默认 30s
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  }, 15_000);

  it("函数形态逐次解析：中途改值对下一次执行生效（设置页保存后无需重启工具实例）", async () => {
    const workspace = makeWorkspace();
    let currentDefaultMs = 60_000;
    const tool = createTerminalTool({
      env: baseEnv,
      defaultTimeoutMs: () => currentDefaultMs,
    });

    // 60s 默认下快速命令正常完成（未被超时打断）
    const before = await tool.execute(
      { command: "echo from-fast" },
      context(workspace)
    );
    expect(before.isError).toBe(false);
    expect(before.output).toContain("from-fast");

    // 改小默认超时：同一实例的下一次执行立即按新值超时
    currentDefaultMs = 3_000;
    const startedAt = Date.now();
    const after = await tool.execute(
      { command: "echo started; sleep 30" },
      context(workspace)
    );
    expect(after.isError).toBe(true);
    expect(after.output).toContain("超时");
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  }, 15_000);

  it("工具描述不携带创建时刻的超时数字（设置可改防过时），保留 timeoutMs 用法指引", () => {
    // 注入非默认值（7/9）同样不出现在描述里：描述不含任何「超时默认 X 秒 /
    // 上限 Y 秒」快照（code review 修复 5），超时实际值由应用设置决定
    const tool = createTerminalTool({
      env: baseEnv,
      defaultTimeoutMs: 7_000,
      maxTimeoutMs: 9_000,
    });
    expect(tool.description).not.toMatch(/超时默认 \d+ 秒/);
    expect(tool.description).not.toMatch(/上限 \d+ 秒/);
    expect(tool.description).toContain("timeoutMs");
    expect(tool.description).toContain("应用设置");
  });

  it("工具描述写清与终端会话工具的适用边界（spec 用户故事 20：长/交互/后台命令引导去会话工具）", () => {
    // spawn_terminal 侧描述有正向边界（短命令请用 run_terminal_command），
    // 本工具侧补反向边界（code review 修复轮）：与 05 票描述措辞呼应
    const tool = createTerminalTool({ env: baseEnv });
    expect(tool.description).toContain("spawn_terminal");
    expect(tool.description).toContain("终端会话工具");
    expect(tool.description).toContain("交互式程序");
    expect(tool.description).toContain("后台存活");
  });

  it("AbortSignal 中断：长命令执行中终止子进程，输出标记为用户中断（区别于超时）", async () => {
    const workspace = makeWorkspace();
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = tool.execute(
      { command: "echo started; sleep 30", timeoutMs: 120_000 },
      {
        workspacePath: workspace,
        approvalMode: "assist",
        taskId: "terminal-test",
        signal: controller.signal,
      }
    );
    // 等 'started' 真正产出后再中断（轮询工作区内产物不可行，改为等一小段固定时间）
    await new Promise((resolve) => setTimeout(resolve, 700));
    controller.abort();
    const result = await pending;
    const elapsed = Date.now() - startedAt;

    expect(result.isError).toBe(true);
    expect(result.output).toContain("started");
    expect(result.output).toContain("已被用户中断");
    expect(result.output).not.toContain("超时");
    // 子进程被立即终止：不能等到 30 秒 sleep 自然结束
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);
});
