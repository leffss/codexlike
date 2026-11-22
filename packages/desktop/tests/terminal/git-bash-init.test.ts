import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureGitBashInitFile,
  winToMsysPath,
} from "../../src/terminal/git-bash-init";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("git-bash 托管 init 文件（窄面板单行提示符）", () => {
  it("ensureGitBashInitFile：userData/terminal 下落盘，内容含 PATH 补齐/用户链/单行 PS1/OSC 标题转义", () => {
    const userData = mkdtempSync(join(tmpdir(), "git-bash-init-"));
    tempDirs.push(userData);
    const { winPath, msysPath } = ensureGitBashInitFile(userData);
    expect(winPath).toBe(join(userData, "terminal", "git-bash-init.sh"));
    const content = readFileSync(winPath, "utf8");
    // PATH 补齐（非登录没有 /etc/profile）
    expect(content).toContain(
      'export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"'
    );
    // locale 兜底（非登录也没有 profile.d/lang.sh）：守卫口径与 lang.sh 一致
    // （LC_ALL/LC_CTYPE/LANG 全未设置才兜底），readline 在 C locale 下逐字节
    // 计宽——CJK 分支名长提示符重绘叠印（2026-11-22「有的项目文字叠印」）
    expect(content).toContain(
      'test -z "${LC_ALL:-${LC_CTYPE:-$LANG}}" && export LANG=C.UTF-8'
    );
    // 用户链：bash_profile 优先，缺失回退 bashrc
    expect(content).toContain(". ~/.bash_profile");
    expect(content).toContain(". ~/.bashrc");
    // git 提示符挂载（__git_ps1 来源）
    expect(content).toContain("/mingw64/share/git/completion/git-prompt.sh");
    // 单行 PS1 + OSC 0 标题转义（动态标题依赖每次提示符刷新）
    expect(content).toContain("PS1=");
    expect(content).toContain("\\033]0;");
    expect(content).not.toMatch(/\\u@\h/); // 不再是 user@host 两行默认式
    // 重复调用幂等（每次启动覆盖）
    ensureGitBashInitFile(userData);
    expect(readFileSync(winPath, "utf8")).toBe(content);
  });

  it("winToMsysPath：应用自产 Windows 路径 → MSYS POSIX 形态", () => {
    expect(
      winToMsysPath("C:\\Users\\u\\AppData\\Roaming\\t\\git-bash-init.sh")
    ).toBe("/c/Users/u/AppData/Roaming/t/git-bash-init.sh");
    expect(winToMsysPath("D:\\x\\y.sh")).toBe("/d/x/y.sh");
  });
});
