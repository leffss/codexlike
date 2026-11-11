import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createWorktreeService } from "../../src/worktree/worktree-service";

/**
 * 托管 Worktree（GLOSSARY）：真实 git fixture 上验证 worktree 创建 / `.worktreeinclude`
 * 复制 / 非 git 报错 / 数量增长保留，不 mock git。
 */
const dirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "codexlike-wt-repo-"));
  dirs.push(dir);
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "e2e@codexlike.local");
  git(dir, "config", "user.name", "CodexLike Test");
  writeFileSync(join(dir, "README.md"), "# 初始\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "初始提交");
  return dir;
}

function makeWorktreesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codexlike-wt-home-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("worktree 创建", () => {
  // 真实 Git 建库、失败回滚与同 id 重试在全套并行下可能超过默认 5 秒；仅为本用例留出进程/I/O预算。
  it(
    "复制中途失败撤销本次副本和分支，修正来源文件后同一 id 可重试",
    { timeout: 15_000 },
    async () => {
      const repo = makeRepo();
      const home = makeWorktreesDir();
      // HEAD 中的 config 是文件，来源工作区把它换成目录：复制目标无法创建。
      writeFileSync(join(repo, "config"), "已提交的文件");
      git(repo, "add", "config");
      git(repo, "commit", "-m", "复制目标冲突");
      rmSync(join(repo, "config"));
      mkdirSync(join(repo, "config"));
      writeFileSync(join(repo, "config", "local.env"), "用户配置");
      writeFileSync(join(repo, ".worktreeinclude"), "config/local.env");
      const service = createWorktreeService({
        worktreesDir: join(home, "worktrees"),
      });
      await expect(
        service.createForSession({
          sessionId: "retry-copy",
          workspacePath: repo,
        })
      ).rejects.toThrow();
      expect(existsSync(join(home, "worktrees", "retry-copy"))).toBe(false);
      expect(git(repo, "branch", "--list", "codexlike/retry-copy").trim()).toBe(
        ""
      );
      expect(readFileSync(join(repo, "config", "local.env"), "utf8")).toBe(
        "用户配置"
      );
      writeFileSync(join(repo, ".worktreeinclude"), "");
      expect(
        (
          await service.createForSession({
            sessionId: "retry-copy",
            workspacePath: repo,
          })
        ).path
      ).toBe(join(home, "worktrees", "retry-copy"));
    }
  );
  it(
    "不再公开按数量清理入口；创建超过旧阈值仍保留早期未提交成果与分支",
    { timeout: 120_000 },
    async () => {
      const repo = makeRepo();
      const home = makeWorktreesDir();
      const service = createWorktreeService({
        worktreesDir: join(home, "worktrees"),
      });
      expect("cleanup" in service).toBe(false);
      for (let i = 0; i < 17; i++) {
        const info = await service.createForSession({
          sessionId: `keep-${i}`,
          workspacePath: repo,
        });
        if (i === 0)
          writeFileSync(join(info.path, "unfinished.txt"), "未提交成果");
      }
      expect(
        readFileSync(
          join(home, "worktrees", "keep-0", "unfinished.txt"),
          "utf8"
        )
      ).toBe("未提交成果");
      expect(git(repo, "branch", "--list", "codexlike/keep-0").trim()).toBe(
        "+ codexlike/keep-0"
      );
    }
  );

  it("拒绝目录逃逸和 Git 元数据覆盖，不删除已有目录、分支或新增成果", async () => {
    const repo = makeRepo();
    const home = makeWorktreesDir();
    const service = createWorktreeService({
      worktreesDir: join(home, "worktrees"),
    });
    await expect(
      service.createForSession({ sessionId: "../outside", workspacePath: repo })
    ).rejects.toThrow();
    expect(existsSync(join(home, "outside"))).toBe(false);
    writeFileSync(join(repo, ".worktreeinclude"), ".git/config");
    await expect(
      service.createForSession({ sessionId: "metadata", workspacePath: repo })
    ).rejects.toThrow();
    expect(existsSync(join(home, "worktrees", "metadata"))).toBe(false);
    writeFileSync(join(repo, ".worktreeinclude"), "../outside");
    await expect(
      service.createForSession({ sessionId: "escape", workspacePath: repo })
    ).rejects.toThrow();
    writeFileSync(join(repo, ".worktreeinclude"), "");
    const existing = join(home, "worktrees", "exists");
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, "keep.txt"), "已有成果");
    await expect(
      service.createForSession({ sessionId: "exists", workspacePath: repo })
    ).rejects.toThrow();
    expect(readFileSync(join(existing, "keep.txt"), "utf8")).toBe("已有成果");
    git(repo, "branch", "codexlike/collision");
    await expect(
      service.createForSession({ sessionId: "collision", workspacePath: repo })
    ).rejects.toThrow();
    expect(git(repo, "branch", "--list", "codexlike/collision").trim()).toBe(
      "codexlike/collision"
    );
    const result = await service.createForSession({
      sessionId: "keep-changes",
      workspacePath: repo,
    });
    writeFileSync(join(result.path, "new-result.txt"), "新成果");
    expect(await result.rollback()).toBe(false);
    expect(readFileSync(join(result.path, "new-result.txt"), "utf8")).toBe(
      "新成果"
    );
  });

  it("创建期间 Git hook 产生的额外成果不能被失败回滚删除", async () => {
    const repo = makeRepo();
    const home = makeWorktreesDir();
    writeFileSync(
      join(repo, ".git", "hooks", "post-checkout"),
      "#!/bin/sh\nprintf hook-result > hook-result.txt\n",
      { mode: 0o755 }
    );
    const service = createWorktreeService({
      worktreesDir: join(home, "worktrees"),
    });
    const result = await service.createForSession({
      sessionId: "hook-result",
      workspacePath: repo,
    });
    expect(readFileSync(join(result.path, "hook-result.txt"), "utf8")).toBe(
      "hook-result"
    );
    expect(await result.rollback()).toBe(false);
    expect(readFileSync(join(result.path, "hook-result.txt"), "utf8")).toBe(
      "hook-result"
    );
  });

  it("没有 HEAD 的 Git 项目失败不遗留目录，补初始提交后同 id 可重试", async () => {
    const repo = makeWorktreesDir();
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "test@codexlike.local");
    git(repo, "config", "user.name", "Test");
    const home = makeWorktreesDir();
    const service = createWorktreeService({
      worktreesDir: join(home, "worktrees"),
    });
    await expect(
      service.createForSession({ sessionId: "unborn", workspacePath: repo })
    ).rejects.toThrow();
    expect(existsSync(join(home, "worktrees", "unborn"))).toBe(false);
    writeFileSync(join(repo, "first.txt"), "初始成果");
    git(repo, "add", "first.txt");
    git(repo, "commit", "-m", "initial");
    expect(
      (
        await service.createForSession({
          sessionId: "unborn",
          workspacePath: repo,
        })
      ).branch
    ).toBe("codexlike/unborn");
  });

  it("在约定目录创建 worktree 与独立分支，检出当前 HEAD 内容", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "tracked.txt"), "被跟踪内容");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "补充 tracked.txt");
    const home = makeWorktreesDir();
    const service = createWorktreeService({
      worktreesDir: join(home, "worktrees"),
    });

    const info = await service.createForSession({
      sessionId: "session-abc",
      workspacePath: repo,
    });

    expect(info.path).toBe(join(home, "worktrees", "session-abc"));
    expect(info.branch).toBe("codexlike/session-abc");
    // worktree 真实存在且检出 HEAD 内容
    expect(existsSync(join(info.path, "README.md"))).toBe(true);
    expect(readFileSync(join(info.path, "tracked.txt"), "utf8")).toBe(
      "被跟踪内容"
    );
    // worktree 当前分支即独立分支；主仓库仍在 main
    expect(git(info.path, "branch", "--show-current").trim()).toBe(
      "codexlike/session-abc"
    );
    expect(git(repo, "branch", "--show-current").trim()).toBe("main");
    // 主仓库分支列表中包含该独立分支（`+` = 分支被检出于其他 worktree，正是预期）
    expect(git(repo, "branch", "--list", "codexlike/session-abc").trim()).toBe(
      "+ codexlike/session-abc"
    );
  });

  it("非 git 目录选 worktree 模式：中文明确报错", async () => {
    const plain = mkdtempSync(join(tmpdir(), "codexlike-wt-plain-"));
    dirs.push(plain);
    const service = createWorktreeService({
      worktreesDir: join(makeWorktreesDir(), "worktrees"),
    });

    await expect(
      service.createForSession({ sessionId: "s1", workspacePath: plain })
    ).rejects.toThrow("不是 git 仓库");
  });

  it("`.worktreeinclude` 声明的被 ignore 文件被复制进副本", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, ".gitignore"), ".env\nnode_modules/\n");
    writeFileSync(join(repo, ".env"), "SECRET=1");
    mkdirSync(join(repo, "config"));
    writeFileSync(join(repo, "config", "local.env"), "DB=local");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-m", "添加 gitignore");
    writeFileSync(
      join(repo, ".worktreeinclude"),
      ".env\nconfig/local.env\n不存在.txt\n"
    );
    const service = createWorktreeService({
      worktreesDir: join(makeWorktreesDir(), "worktrees"),
    });

    const info = await service.createForSession({
      sessionId: "session-env",
      workspacePath: repo,
    });

    // 声明的两个文件都进了副本，内容一致
    expect(readFileSync(join(info.path, ".env"), "utf8")).toBe("SECRET=1");
    expect(readFileSync(join(info.path, "config", "local.env"), "utf8")).toBe(
      "DB=local"
    );
    // 不存在的行跳过、不报错；未声明的被 ignore 文件不复制（本例没有其他被 ignore 文件）
    expect(existsSync(join(info.path, "不存在.txt"))).toBe(false);
    expect(info.copiedFiles.sort()).toEqual([".env", "config/local.env"]);
  });

  it("无 `.worktreeinclude` 时创建正常、复制清单为空", async () => {
    const repo = makeRepo();
    const service = createWorktreeService({
      worktreesDir: join(makeWorktreesDir(), "worktrees"),
    });

    const info = await service.createForSession({
      sessionId: "session-plain",
      workspacePath: repo,
    });

    expect(info.copiedFiles).toEqual([]);
    expect(existsSync(info.path)).toBe(true);
  });

  it("目标目录已存在时中文报错（会话 id 冲突防御）", async () => {
    const repo = makeRepo();
    const home = makeWorktreesDir();
    mkdirSync(join(home, "worktrees", "session-dup"), { recursive: true });
    const service = createWorktreeService({
      worktreesDir: join(home, "worktrees"),
    });

    await expect(
      service.createForSession({
        sessionId: "session-dup",
        workspacePath: repo,
      })
    ).rejects.toThrow("已存在");
  });
});
