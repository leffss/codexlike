import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  composeSystemPrompt,
  discoverAgentsInstructions,
} from "../../src/context/agents-md";

/** 真实临时目录做工作区（spec 测试决策：文件系统行为不 mock） */
const roots: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codexlike-agents-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 无 git 场景的根探测注入 */
const noGit = () => null;

describe("discoverAgentsInstructions（AGENTS.md 发现）", () => {
  it("无法读取的规范记录诊断，不阻断其余规范发现", () => {
    const globalDir = makeDir();
    const workspacePath = makeDir();
    mkdirSync(join(globalDir, "AGENTS.md"));
    writeFileSync(join(workspacePath, "AGENTS.md"), "可用规范");
    const discovery = discoverAgentsInstructions({
      globalDir,
      workspacePath,
      findGitRoot: noGit,
    });
    expect(discovery.combined).toContain("可用规范");
    expect(discovery.diagnostics).toContainEqual(
      expect.objectContaining({ path: join(globalDir, "AGENTS.md") })
    );
  });
  it("截断诊断逐来源记录原始字节数和真正注入的正文份额", () => {
    const globalDir = makeDir();
    const workspacePath = makeDir();
    const cwd = join(workspacePath, "child");
    mkdirSync(cwd);
    writeFileSync(join(globalDir, "AGENTS.md"), "全".repeat(7000));
    writeFileSync(join(workspacePath, "AGENTS.md"), "项".repeat(7000));
    writeFileSync(join(cwd, "AGENTS.md"), "未注入");
    const result = discoverAgentsInstructions({
      globalDir,
      workspacePath,
      cwd,
      findGitRoot: () => workspacePath,
    });
    expect(result.sections[0]).toMatchObject({
      bytes: 21000,
      includedBytes: 21000,
    });
    expect(result.sections[1]?.includedBytes).toBeGreaterThan(0);
    expect(result.sections[1]?.includedBytes).toBeLessThan(21000);
    expect(result.sections[2]).toMatchObject({ bytes: 9, includedBytes: 0 });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        path: join(workspacePath, "AGENTS.md"),
        message: expect.stringContaining("32 KiB"),
      })
    );
    expect(result.combined).not.toContain("\uFFFD");
  });
  it("情形一：全局与项目都没有 AGENTS.md → 无节、combined 为空", () => {
    const globalDir = makeDir();
    const workspace = makeDir();
    const result = discoverAgentsInstructions({
      globalDir,
      workspacePath: workspace,
      findGitRoot: noGit,
    });
    expect(result.sections).toEqual([]);
    expect(result.combined).toBe("");
    expect(result.truncated).toBe(false);
  });

  it("情形二：仅全局有 AGENTS.md → 单节 source=global，combined 含其内容与来源路径", () => {
    const globalDir = makeDir();
    writeFileSync(join(globalDir, "AGENTS.md"), "回答保持简洁。");
    const workspace = makeDir();

    const result = discoverAgentsInstructions({
      globalDir,
      workspacePath: workspace,
      findGitRoot: noGit,
    });

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]).toMatchObject({
      source: "global",
      path: join(globalDir, "AGENTS.md"),
      content: "回答保持简洁。",
    });
    expect(result.combined).toContain("回答保持简洁。");
    expect(result.truncated).toBe(false);
  });

  it("情形三：全局 + git 根 → cwd 逐层叠加，顺序为全局 → 根 → 内层", () => {
    const globalDir = makeDir();
    writeFileSync(join(globalDir, "AGENTS.md"), "[全局规范内容]");
    const workspace = makeDir();
    mkdirSync(join(workspace, "sub"));
    writeFileSync(join(workspace, "AGENTS.md"), "[根目录规范内容]");
    writeFileSync(join(workspace, "sub", "AGENTS.md"), "[子目录规范内容]");

    const result = discoverAgentsInstructions({
      globalDir,
      workspacePath: workspace,
      cwd: join(workspace, "sub"),
      findGitRoot: () => workspace,
    });

    expect(result.sections.map((section) => section.content)).toEqual([
      "[全局规范内容]",
      "[根目录规范内容]",
      "[子目录规范内容]",
    ]);
    expect(result.sections.map((section) => section.source)).toEqual([
      "global",
      "project",
      "project",
    ]);

    // 拼接保持同序：全局在最前、根其次、子目录最后
    const combined = result.combined;
    expect(combined.indexOf("[全局规范内容]")).toBeLessThan(
      combined.indexOf("[根目录规范内容]")
    );
    expect(combined.indexOf("[根目录规范内容]")).toBeLessThan(
      combined.indexOf("[子目录规范内容]")
    );
  });

  it("中间目录没有 AGENTS.md 的层自然跳过", () => {
    const workspace = makeDir();
    mkdirSync(join(workspace, "a"), { recursive: true });
    mkdirSync(join(workspace, "a", "b"), { recursive: true });
    writeFileSync(join(workspace, "AGENTS.md"), "[根内容]");
    writeFileSync(join(workspace, "a", "b", "AGENTS.md"), "[b 层内容]");

    const result = discoverAgentsInstructions({
      globalDir: makeDir(),
      workspacePath: workspace,
      cwd: join(workspace, "a", "b"),
      findGitRoot: () => workspace,
    });

    expect(result.sections.map((section) => section.content)).toEqual([
      "[根内容]",
      "[b 层内容]",
    ]);
  });

  it("无 git 时项目根退化为工作区目录", () => {
    const workspace = makeDir();
    writeFileSync(join(workspace, "AGENTS.md"), "[工作区规范]");

    const result = discoverAgentsInstructions({
      globalDir: makeDir(),
      workspacePath: workspace,
      findGitRoot: noGit,
    });

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]).toMatchObject({
      source: "project",
      path: join(workspace, "AGENTS.md"),
    });
  });

  it("拼接总量超过 32 KiB 时截断并标记 truncated", () => {
    const globalDir = makeDir();
    // 拉丁字符 1 字节：全局节 20 KiB + 项目根 20 KiB → 拼接 40 KiB+ 超限
    writeFileSync(
      join(globalDir, "AGENTS.md"),
      `全局：${"a".repeat(20 * 1024)}`
    );
    const workspace = makeDir();
    writeFileSync(
      join(workspace, "AGENTS.md"),
      `项目：${"b".repeat(20 * 1024)}`
    );

    const result = discoverAgentsInstructions({
      globalDir,
      workspacePath: workspace,
      findGitRoot: noGit,
    });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.combined, "utf8")).toBeLessThanOrEqual(
      32 * 1024
    );
    // 截断按 UTF-8 字节计，不得产生半个字符的替换符
    expect(result.combined).not.toContain("\uFFFD");
    // 全局节在前完整保留，截断发生在项目节内（b 数量远少于写入的 20 KiB）
    expect(result.combined).toContain("全局：");
    expect(result.combined.match(/b/g)?.length ?? 0).toBeLessThan(19 * 1024);
  });
});

describe("composeSystemPrompt（系统提示组装）", () => {
  it("无 AGENTS.md → 空串（不注入系统提示，保持既有行为）", () => {
    const workspace = makeDir();
    const discovery = discoverAgentsInstructions({
      globalDir: makeDir(),
      workspacePath: workspace,
      findGitRoot: noGit,
    });
    expect(composeSystemPrompt(discovery)).toBe("");
  });

  it("有 AGENTS.md → 系统提示含规范标题、来源标注与各节内容", () => {
    const globalDir = makeDir();
    writeFileSync(join(globalDir, "AGENTS.md"), "[全局规范内容]");
    const workspace = makeDir();
    writeFileSync(join(workspace, "AGENTS.md"), "[项目规范内容]");

    const discovery = discoverAgentsInstructions({
      globalDir,
      workspacePath: workspace,
      findGitRoot: noGit,
    });
    const prompt = composeSystemPrompt(discovery);

    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("全局规范");
    expect(prompt).toContain("项目规范");
    expect(prompt).toContain("[全局规范内容]");
    expect(prompt).toContain("[项目规范内容]");
    expect(prompt).toContain(join(workspace, "AGENTS.md"));
  });
});
