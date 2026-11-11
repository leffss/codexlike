import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTerminalTool } from '../../src/tools/terminal';
import type { ToolExecutionContext } from '../../src/tools/types';

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
}

function context(workspacePath: string): ToolExecutionContext {
  return { workspacePath, sessionId: 'unit-test-session' };
}

/** 与生产宿主同构：传完整 process.env，工具层做白名单过滤 */
const baseEnv = { ...process.env };

describe('run_terminal_command 工具（默认 Git Bash）', () => {
  const tool = createTerminalTool({ env: baseEnv });

  it(
    '基础命令执行并返回 stdout',
    async () => {
      const workspace = makeWorkspace();
      const result = await tool.execute({ command: 'echo hello-from-bash' }, context(workspace));
      expect(result.isError).toBe(false);
      expect(result.output).toContain('hello-from-bash');
    },
    15_000,
  );

  it(
    'POSIX 命令组合（ls、&&、管道）在 Windows 上经 Git Bash 正常执行',
    async () => {
      const workspace = makeWorkspace();
      writeFileSync(join(workspace, 'a.txt'), 'x');
      writeFileSync(join(workspace, 'b.txt'), 'y');

      const result = await tool.execute(
        { command: 'ls *.txt | sort && echo done' },
        context(workspace),
      );
      expect(result.isError).toBe(false);
      expect(result.output).toContain('a.txt');
      expect(result.output).toContain('b.txt');
      expect(result.output).toContain('done');
    },
    15_000,
  );

  it(
    'cwd 默认为工作区（pwd 落在工作区内），stderr 单独成节，非零退出码标记为失败',
    async () => {
      const workspace = makeWorkspace();
      const pwd = await tool.execute({ command: 'pwd' }, context(workspace));
      expect(pwd.isError).toBe(false);
      expect(pwd.output.toLowerCase()).toContain('codexlike-ws-');

      const failing = await tool.execute(
        { command: 'echo Oops >&2; exit 3' },
        context(workspace),
      );
      expect(failing.isError).toBe(true);
      expect(failing.output).toContain('Oops');
      expect(failing.output).toContain('3');
    },
    15_000,
  );

  it(
    '超时：强制终止并返回已收集输出与超时标记',
    async () => {
      const workspace = makeWorkspace();
      const result = await tool.execute(
        { command: 'echo started; sleep 30', timeoutMs: 500 },
        context(workspace),
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain('started');
      expect(result.output).toContain('超时');
    },
    15_000,
  );

  it(
    '超长输出被截断并带标记',
    async () => {
      const workspace = makeWorkspace();
      const small = createTerminalTool({ env: baseEnv, maxOutputLength: 200 });
      const result = await small.execute({ command: 'seq 1 20000' }, context(workspace));
      expect(result.isError).toBe(false);
      expect(result.output).toContain('[输出已截断');
      expect(result.output.length).toBeLessThan(1_000);
    },
    15_000,
  );

  it(
    '环境变量白名单：PATH 等基础项可用，未列名变量不透传',
    async () => {
      const workspace = makeWorkspace();
      const withSecret = { ...baseEnv, CODEXLIKE_TEST_SECRET: 'do-not-leak' };
      const strict = createTerminalTool({ env: withSecret });

      const pathOk = await strict.execute({ command: 'printenv PATH' }, context(workspace));
      expect(pathOk.isError).toBe(false);
      expect(pathOk.output.trim().length).toBeGreaterThan(0);

      const leak = await strict.execute(
        { command: 'printenv CODEXLIKE_TEST_SECRET && echo LEAKED || echo NOT_LEAKED' },
        context(workspace),
      );
      expect(leak.output).toContain('NOT_LEAKED');
      expect(leak.output).not.toContain('do-not-leak');
    },
    15_000,
  );

  it(
    '命令中的 Windows 反斜杠绝对路径在工具层转换为 POSIX（bash 可直接使用）',
    async () => {
      const workspace = makeWorkspace();
      writeFileSync(join(workspace, 'note.txt'), 'path-conversion-works');

      const result = await tool.execute(
        { command: `cat "${workspace}\\note.txt"` },
        context(workspace),
      );
      expect(result.isError).toBe(false);
      expect(result.output).toContain('path-conversion-works');
    },
    15_000,
  );

  it(
    'cwd 参数限定子目录；越界 cwd 被拒',
    async () => {
      const workspace = makeWorkspace();
      const inSub = await tool.execute(
        { command: 'pwd', cwd: '.' },
        context(workspace),
      );
      expect(inSub.isError).toBe(false);

      const escape = await tool.execute(
        { command: 'pwd', cwd: '..' },
        context(workspace),
      );
      expect(escape.isError).toBe(true);
      expect(escape.output).toContain('路径越界');
    },
    15_000,
  );

  it(
    '可配置 PowerShell：命令经 powershell.exe 执行',
    async () => {
      if (process.platform !== 'win32') return; // Windows 优先（spec），其它平台跳过
      const workspace = makeWorkspace();
      const powershell = createTerminalTool({ env: baseEnv, shell: 'powershell' });
      const result = await powershell.execute(
        { command: 'Write-Output hello-from-ps' },
        context(workspace),
      );
      expect(result.isError).toBe(false);
      expect(result.output).toContain('hello-from-ps');
    },
    30_000,
  );

  it(
    'shell 支持函数形态逐次解析：中途切换对后续命令生效（设置页保存后无需重启工具实例）',
    async () => {
      if (process.platform !== 'win32') return; // PowerShell/cmd 仅 Windows
      const workspace = makeWorkspace();
      let current: 'git-bash' | 'cmd' = 'git-bash';
      const tool = createTerminalTool({ env: baseEnv, shell: () => current });

      // Git Bash：POSIX 语法可用
      const viaBash = await tool.execute(
        { command: 'echo from-bash && cat /dev/null' },
        context(workspace),
      );
      expect(viaBash.isError).toBe(false);
      expect(viaBash.output).toContain('from-bash');

      // 切到 cmd：同一工具实例的下一次执行立即用 cmd（POSIX 语法不可用，cmd 语法 echo 可用）
      current = 'cmd';
      const viaCmd = await tool.execute({ command: 'echo from-cmd' }, context(workspace));
      expect(viaCmd.isError).toBe(false);
      expect(viaCmd.output).toContain('from-cmd');
    },
    30_000,
  );

  it(
    'AbortSignal 中断：长命令执行中终止子进程，输出标记为用户中断（区别于超时）',
    async () => {
      const workspace = makeWorkspace();
      const controller = new AbortController();
      const startedAt = Date.now();
      const pending = tool.execute(
        { command: 'echo started; sleep 30', timeoutMs: 120_000 },
        { workspacePath: workspace, sessionId: 'terminal-test', signal: controller.signal },
      );
      // 等 'started' 真正产出后再中断（轮询工作区内产物不可行，改为等一小段固定时间）
      await new Promise((resolve) => setTimeout(resolve, 700));
      controller.abort();
      const result = await pending;
      const elapsed = Date.now() - startedAt;

      expect(result.isError).toBe(true);
      expect(result.output).toContain('started');
      expect(result.output).toContain('已被用户中断');
      expect(result.output).not.toContain('超时');
      // 子进程被立即终止：不能等到 30 秒 sleep 自然结束
      expect(elapsed).toBeLessThan(10_000);
    },
    30_000,
  );
});
