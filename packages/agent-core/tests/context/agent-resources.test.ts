import {
  mkdtempSync,
  mkdirSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// 非功能 I/O 约束：仅观察真实 fs 读取，不替换目录或文件内容。
vi.mock("node:fs", { spy: true });

import { createAgentResourceSnapshot } from "../../src/context/agent-resources";
import type { ResourceExecution } from "../../src/context/resource-types";
import { estimateTokens } from "../../src/context/tokens";

async function invoke(
  execution: ResourceExecution,
  name: string,
  args: unknown
) {
  const tool = execution.tools.find((entry) => entry.name === name)!;
  expect(tool.permission).toBe("readonly");
  return tool.execute(args, {
    workspacePath: "",
    sessionId: "test",
    approvalMode: "full-access",
  });
}

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-resources-"));
  roots.push(root);
  const workspacePath = join(root, "project");
  const globalDir = join(root, "global");
  const compatibleGlobalDir = join(root, "compatible");
  for (const directory of [workspacePath, globalDir, compatibleGlobalDir]) {
    mkdirSync(directory);
  }
  return {
    root,
    workspacePath,
    globalDir,
    compatibleGlobalDir,
    findGitRoot: () => null,
  };
}
function put(path: string, content: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function skill(
  base: string,
  name: string,
  body = "秘密技能正文",
  description = "技能用途说明"
) {
  const path = join(base, "skills", name, "SKILL.md");
  put(path, `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
  return path;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("资源快照公开发现与加载接口", () => {
  it("名称须包含字母，拒绝金额歧义项但允许字母数字混合技能", () => {
    const options = fixture();
    const invalidPath = skill(options.globalDir, "123-456");
    skill(options.globalDir, "123-review");
    const snapshot = createAgentResourceSnapshot(options);
    expect(
      snapshot.catalog.skills.find((entry) => entry.path === invalidPath)
    ).toMatchObject({
      status: "invalid",
      reason: expect.stringContaining("字母"),
    });
    expect(
      snapshot.catalog.skills
        .filter((entry) => entry.status === "active")
        .map((entry) => entry.name)
    ).toEqual(["123-review"]);
    expect(() =>
      snapshot.createExecution("main").loadExplicit(["123-456"])
    ).toThrow();
  });
  it.each(["\n", "\r\n"])(
    "发现只读取 frontmatter，不提前读取短文件正文（换行 %j）",
    (newline) => {
      const options = fixture();
      const path = join(options.globalDir, "skills", "review", "SKILL.md");
      const frontmatter = [
        "---",
        "name: review",
        "description: 审查用途",
        "---",
        "",
      ].join(newline);
      put(path, `${frontmatter}不应提前读取的正文`);
      const reads = vi.mocked(readSync);
      reads.mockClear();
      const snapshot = createAgentResourceSnapshot(options);
      expect(snapshot.catalog.skills).toEqual([
        expect.objectContaining({ name: "review", status: "active" }),
      ]);
      const bytesRead = reads.mock.results.reduce(
        (sum, result) => sum + (result.type === "return" ? result.value : 0),
        0
      );
      expect(bytesRead).toBe(Buffer.byteLength(frontmatter));
      reads.mockClear();
      expect(
        snapshot.createExecution("main").loadExplicit(["review"])
      ).toContain("不应提前读取的正文");
      expect(
        reads.mock.results.some(
          (result) =>
            result.type === "return" &&
            result.value > Buffer.byteLength(frontmatter)
        )
      ).toBe(true);
    }
  );
  it("发现阶段也拒绝 skills 根目录链接逃逸，不能借链接读取工作区外技能", () => {
    const options = fixture();
    const external = join(options.root, "external");
    skill(external, "outside");
    const config = join(options.workspacePath, ".codexlike");
    mkdirSync(config);
    symlinkSync(join(external, "skills"), join(config, "skills"), "junction");
    const snapshot = createAgentResourceSnapshot(options);
    expect(
      snapshot.catalog.skills.filter((entry) => entry.status === "active")
    ).toEqual([]);
    expect(
      snapshot.catalog.diagnostics.some((entry) => /越界/.test(entry.message))
    ).toBe(true);
  });
  it("即使 full-access 也拒绝绝对路径、逃逸、二进制、非普通文件和超限资源", async () => {
    const options = fixture();
    const path = skill(options.globalDir, "review");
    const directory = dirname(path);
    put(join(directory, "ok.md"), "安全资源");
    put(join(directory, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    put(join(directory, "invalid-utf8.txt"), Buffer.from([255, 254, 255]));
    put(join(directory, "large.txt"), "a".repeat(32 * 1024 + 1));
    const snapshot = createAgentResourceSnapshot(options);
    const execution = snapshot.createExecution("main");
    execution.loadExplicit(["review"]);
    for (const resource of [
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "../SKILL.md",
      "..\\SKILL.md",
      "ok.md:stream",
      "binary.bin",
      "invalid-utf8.txt",
      "large.txt",
      ".",
    ]) {
      const result = await invoke(execution, "read_skill_resource", {
        name: "review",
        path: resource,
      });
      expect(result.isError, resource).toBe(true);
    }
    expect(snapshot.summary().loaded).toHaveLength(1);
    expect(
      (
        await invoke(execution, "read_skill_resource", {
          name: "review",
          path: "./ok.md",
        })
      ).isError
    ).toBe(false);
    skill(options.globalDir, "huge", "x".repeat(64 * 1024));
    skill(options.globalDir, "binary", "hello\u0000body");
    const refreshed = createAgentResourceSnapshot(options);
    expect(() =>
      refreshed.createExecution("main").loadExplicit(["huge"])
    ).toThrow(/64 KiB/);
    expect(() =>
      refreshed.createExecution("main").loadExplicit(["binary"])
    ).toThrow(/二进制/);
  });

  it("拒绝目录 junction 逃逸和快照后重定向，允许技能内部链接并检测循环", async () => {
    const options = fixture();
    const path = skill(options.globalDir, "review");
    const directory = dirname(path);
    const inside = join(directory, "inside");
    const outside = join(options.root, "outside");
    put(join(inside, "guide.md"), "内部资源");
    put(join(outside, "guide.md"), "外部秘密");
    symlinkSync(outside, join(directory, "escape"), "junction");
    symlinkSync(inside, join(directory, "linked"), "junction");
    symlinkSync(directory, join(directory, "loop"), "junction");
    const snapshot = createAgentResourceSnapshot(options);
    const execution = snapshot.createExecution("main");
    execution.loadExplicit(["review"]);
    expect(
      snapshot.catalog.diagnostics.some((entry) => /越界/.test(entry.message))
    ).toBe(true);
    expect(
      snapshot.catalog.diagnostics.some((entry) => /循环/.test(entry.message))
    ).toBe(true);
    expect(
      (
        await invoke(execution, "read_skill_resource", {
          name: "review",
          path: "escape/guide.md",
        })
      ).isError
    ).toBe(true);
    expect(
      (
        await invoke(execution, "read_skill_resource", {
          name: "review",
          path: "linked/guide.md",
        })
      ).output
    ).toContain("内部资源");
    rmSync(join(directory, "linked"));
    symlinkSync(outside, join(directory, "linked"), "junction");
    const child = snapshot.createExecution("child");
    child.loadExplicit(["review"]);
    expect(
      (
        await invoke(child, "read_skill_resource", {
          name: "review",
          path: "linked/guide.md",
        })
      ).isError
    ).toBe(true);
  });
  it("近项目优于远项目与全局、同层 codexlike 优先，无效覆盖项保留诊断且不回退", () => {
    const options = fixture();
    const nested = join(options.workspacePath, "child");
    mkdirSync(nested);
    const sameName = "review";
    skill(options.compatibleGlobalDir, sameName, "兼容全局");
    skill(options.globalDir, sameName, "应用全局");
    skill(join(options.workspacePath, ".codexlike"), sameName, "项目根");
    skill(join(nested, ".agents"), sameName, "近项目兼容");
    const winner = skill(join(nested, ".codexlike"), sameName, "近项目应用");
    const snapshot = createAgentResourceSnapshot({
      ...options,
      workspacePath: nested,
      findGitRoot: () => options.workspacePath,
    });
    expect(
      snapshot.catalog.skills
        .filter((entry) => entry.status === "active")
        .map((entry) => entry.path)
    ).toEqual([winner]);
    expect(
      snapshot.catalog.skills.filter((entry) => entry.status === "shadowed")
    ).toHaveLength(4);
    expect(snapshot.createExecution("main").loadExplicit([sameName])).toContain(
      "近项目应用"
    );
    put(winner, "---\nname: wrong\ndescription: broken\n---\n无效覆盖");
    const invalid = createAgentResourceSnapshot({
      ...options,
      workspacePath: nested,
      findGitRoot: () => options.workspacePath,
    });
    expect(
      invalid.catalog.skills.find((entry) => entry.path === winner)?.status
    ).toBe("invalid");
    expect(
      invalid.catalog.skills.filter((entry) => entry.status === "active")
    ).toEqual([]);
    expect(() =>
      invalid.createExecution("main").loadExplicit([sameName])
    ).toThrow();
    expect(invalid.catalog.diagnostics).toContainEqual(
      expect.objectContaining({ path: winner })
    );
    const nonGit = createAgentResourceSnapshot({
      ...options,
      workspacePath: nested,
    });
    expect(
      nonGit.catalog.skills.some((entry) =>
        entry.path.includes(join("project", ".codexlike"))
      )
    ).toBe(false);
  });

  it("支持 YAML 多行描述；缺字段、名称错误、重复键、超过有界前言的元数据均无效", () => {
    const options = fixture();
    const base = join(options.workspacePath, ".agents");
    const good = skill(base, "good");
    put(
      good,
      "---\nname: good\ndescription: >-\n  第一行\n  第二行\n---\n不进目录的正文"
    );
    skill(base, "BadName");
    skill(base, "double--dash");
    const duplicate = skill(base, "duplicate");
    put(
      duplicate,
      "---\nname: duplicate\ndescription: first\ndescription: second\n---\nbody"
    );
    const missing = skill(base, "missing");
    put(missing, "---\nname: missing\n---\nbody");
    const huge = skill(base, "huge");
    put(
      huge,
      `---\nname: huge\ndescription: ${"x".repeat(20 * 1024)}\n---\nbody`
    );
    const snapshot = createAgentResourceSnapshot(options);
    expect(
      snapshot.catalog.skills.filter((entry) => entry.status === "active")
    ).toEqual([
      expect.objectContaining({ name: "good", description: "第一行 第二行" }),
    ]);
    expect(
      snapshot.catalog.skills.filter((entry) => entry.status === "invalid")
    ).toHaveLength(5);
  });
  it("单执行者加载总量为 256 KiB，超限事务不部分提交，重复读取不重复占预算", async () => {
    const options = fixture();
    for (const name of ["one", "two", "three", "four", "five"])
      skill(options.globalDir, name, "x".repeat(60 * 1024));
    const path = join(options.globalDir, "skills", "one", "reference.md");
    put(path, "r".repeat(20 * 1024));
    const snapshot = createAgentResourceSnapshot(options);
    const main = snapshot.createExecution("main");
    main.loadExplicit(["one", "two", "three"]);
    expect(() => main.loadExplicit(["four", "five"])).toThrow(/256 KiB/);
    expect(snapshot.summary().loaded.map((entry) => entry.name)).toEqual([
      "one",
      "two",
      "three",
    ]);
    main.loadExplicit(["four"]);
    for (let repeat = 0; repeat < 5; repeat++)
      expect((await invoke(main, "load_skill", { name: "one" })).isError).toBe(
        false
      );
    const over = await invoke(main, "read_skill_resource", {
      name: "one",
      path: "reference.md",
    });
    expect(over.isError).toBe(true);
    expect(over.output).toContain("256 KiB");
    const child = snapshot.createExecution("child");
    child.loadExplicit(["one"]);
    expect(
      (
        await invoke(child, "read_skill_resource", {
          name: "one",
          path: "reference.md",
        })
      ).isError
    ).toBe(false);
  });
  it("附属资源必须先加载技能，沿快照版本加载并缓存，不读取运行后新增资源", async () => {
    const options = fixture();
    const path = skill(options.globalDir, "review");
    const resourcePath = join(dirname(path), "references", "guide.md");
    put(resourcePath, "参考正文");
    const snapshot = createAgentResourceSnapshot(options);
    const main = snapshot.createExecution("main");
    expect(
      (
        await invoke(main, "read_skill_resource", {
          name: "review",
          path: "references/guide.md",
        })
      ).isError
    ).toBe(true);
    main.loadExplicit(["review"]);
    const first = await invoke(main, "read_skill_resource", {
      name: "review",
      path: "references/guide.md",
    });
    expect(first.isError).toBe(false);
    expect(first.output).toContain("参考正文");
    expect(first.output).toContain(resourcePath);
    expect(first.output).toContain(dirname(path));
    put(resourcePath, "资源已改变");
    expect(
      await invoke(main, "read_skill_resource", {
        name: "review",
        path: "references/guide.md",
      })
    ).toEqual(first);
    const child = snapshot.createExecution("child");
    child.loadExplicit(["review"]);
    const changed = await invoke(child, "read_skill_resource", {
      name: "review",
      path: "references/guide.md",
    });
    expect(changed.isError).toBe(true);
    expect(changed.output).toMatch(/变化|变更/);
    put(join(dirname(path), "new.md"), "新增资源");
    expect(
      (
        await invoke(main, "read_skill_resource", {
          name: "review",
          path: "new.md",
        })
      ).isError
    ).toBe(true);
    expect(
      snapshot.summary().loaded.filter((entry) => entry.kind === "resource")
    ).toEqual([
      expect.objectContaining({
        executorId: "main",
        path: resourcePath,
        bytes: 12,
      }),
    ]);
  });
  it("未加载正文变更报错，已加载正文缓存且其他执行者不能继承缓存", async () => {
    const options = fixture();
    const path = skill(options.globalDir, "review", "原始正文");
    const snapshot = createAgentResourceSnapshot(options);
    const main = snapshot.createExecution("main");
    const original = main.loadExplicit(["review"]);
    put(path, "修改后的正文，元数据也被替换");
    expect(main.loadExplicit(["review"])).toBe(original);
    const result = await invoke(
      snapshot.createExecution("child"),
      "load_skill",
      { name: "review" }
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/变化|变更/);
    expect(snapshot.summary().loaded).toHaveLength(1);
    expect(createAgentResourceSnapshot(options).catalog.skills[0]?.status).toBe(
      "invalid"
    );
  });
  it("显式加载去重有序且事务失败不部分记录，主子代理加载状态独立", async () => {
    const options = fixture();
    const alpha = skill(options.globalDir, "alpha", "ALPHA 正文");
    skill(options.globalDir, "beta", "BETA 正文");
    const snapshot = createAgentResourceSnapshot(options);
    const main = snapshot.createExecution("main");
    expect(() => main.loadExplicit(["beta", "missing"])).toThrow();
    expect(snapshot.summary().loaded).toEqual([]);
    const text = main.loadExplicit(["beta", "alpha", "beta"]);
    expect(text.indexOf("BETA 正文")).toBeLessThan(text.indexOf("ALPHA 正文"));
    expect(text.match(/BETA 正文/g)).toHaveLength(1);
    expect(text).toContain(alpha);
    expect(text).toContain(dirname(alpha));
    expect(
      snapshot.summary().loaded.map((entry) => [entry.executorId, entry.name])
    ).toEqual([
      ["main", "beta"],
      ["main", "alpha"],
    ]);
    expect(snapshot.summary().estimatedTokens).toBe(
      estimateTokens(snapshot.systemPrompt) + estimateTokens(text)
    );
    const child = snapshot.createExecution("child");
    expect(
      (await invoke(child, "load_skill", { name: "alpha" })).output
    ).toContain("ALPHA 正文");
    expect(snapshot.summary().loaded.map((entry) => entry.executorId)).toEqual([
      "main",
      "main",
      "child",
    ]);
    expect(snapshot.summary().estimatedTokens).toBe(
      estimateTokens(snapshot.systemPrompt) + estimateTokens(text)
    );
  });
  it("索引按 16 KiB 有界，完整排除超预算条目并提供诊断", () => {
    const options = fixture();
    for (let index = 0; index < 30; index++) {
      skill(
        join(options.workspacePath, ".agents"),
        `skill-${index}`,
        "不应预载正文",
        "界".repeat(400)
      );
    }
    const snapshot = createAgentResourceSnapshot(options);
    expect(snapshot.catalog.indexBytes).toBeLessThanOrEqual(16 * 1024);
    const excluded = snapshot.catalog.skills.filter(
      (entry) => entry.status === "excluded"
    );
    expect(excluded.length).toBeGreaterThan(0);
    for (const entry of excluded) {
      expect(snapshot.systemPrompt).not.toContain(`- ${entry.name}:`);
      expect(snapshot.catalog.diagnostics).toContainEqual(
        expect.objectContaining({ path: entry.path })
      );
    }
  });
  it("自动注入规范和索引，但目录及系统提示不包含技能正文", () => {
    const options = fixture();
    put(join(options.globalDir, "AGENTS.md"), "全局规范");
    put(join(options.workspacePath, "AGENTS.md"), "项目规范");
    const path = skill(join(options.workspacePath, ".codexlike"), "review");
    const snapshot = createAgentResourceSnapshot(options);
    expect(snapshot.systemPrompt).toContain("全局规范");
    expect(snapshot.systemPrompt).toContain("项目规范");
    expect(snapshot.systemPrompt).toContain("review");
    expect(snapshot.systemPrompt).toContain("技能用途说明");
    expect(snapshot.systemPrompt).not.toContain("秘密技能正文");
    expect(JSON.stringify(snapshot.catalog)).not.toContain("秘密技能正文");
    expect(snapshot.catalog.skills).toEqual([
      expect.objectContaining({
        name: "review",
        path,
        source: "codexlike",
        scope: "project",
        status: "active",
      }),
    ]);
    expect(snapshot.catalog.agents.sources).toEqual([
      expect.objectContaining({
        scope: "global",
        bytes: 12,
        includedBytes: 12,
      }),
      expect.objectContaining({
        scope: "project",
        bytes: 12,
        includedBytes: 12,
      }),
    ]);
    expect(snapshot.summary().loaded).toEqual([]);
    expect(snapshot.summary().estimatedTokens).toBeGreaterThan(0);
  });
});
