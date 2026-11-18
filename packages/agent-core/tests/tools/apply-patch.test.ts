import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApplyPatchTool } from "../../src/tools/apply-patch";
import type { ToolExecutionContext } from "../../src/tools/types";

// file symlink 在 Windows 可能需提权：仅在文件系统边界模拟它的跟随语义，
// 文件内容仍真实落盘；lstat 链接元数据来自本测试创建的真实 junction/目录链接。
const danglingFile = vi.hoisted(() => ({
  alias: "",
  target: "",
  metadata: "",
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: (...args: Parameters<typeof actual.realpathSync>) => {
      if (args[0] === danglingFile.alias) args[0] = danglingFile.target;
      return actual.realpathSync(...args);
    },
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (args[0] === danglingFile.alias) args[0] = danglingFile.metadata;
      return actual.lstatSync(...args);
    },
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      actual.existsSync(
        path === danglingFile.alias ? danglingFile.target : path
      ),
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (args[0] === danglingFile.alias) args[0] = danglingFile.target;
      return actual.writeFileSync(...args);
    },
  };
});

const workspaces: string[] = [];

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
  workspaces.push(workspace);
  return workspace;
}

afterEach(() => {
  danglingFile.alias = "";
  danglingFile.target = "";
  danglingFile.metadata = "";
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function context(workspacePath: string): ToolExecutionContext {
  return {
    workspacePath,
    taskId: "unit-test-task",
    approvalMode: "assist",
  };
}

const tool = createApplyPatchTool();

describe("apply_patch 工具", () => {
  it("上下文行精确匹配：修改成功且文件真实落盘", async () => {
    const workspace = makeWorkspace();
    writeFileSync(
      join(workspace, "calc.ts"),
      "export function add(a: number, b: number) {\n  return a + b;\n}\n",
      "utf8"
    );

    const patch = [
      "*** Begin Patch",
      "*** Update File: calc.ts",
      " export function add(a: number, b: number) {",
      "-  return a + b;",
      "+  return a + b + 0;",
      " }",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));
    expect(result.isError).toBe(false);
    expect(result.output).toContain("calc.ts");
    expect(readFileSync(join(workspace, "calc.ts"), "utf8")).toBe(
      "export function add(a: number, b: number) {\n  return a + b + 0;\n}\n"
    );
  });

  it("上下文失配：拒绝应用，错误含期望行、文件实际相近行与重试提示，文件保持原样", async () => {
    const workspace = makeWorkspace();
    const original = 'def greet():\n    print("hello world")\n';
    writeFileSync(join(workspace, "hello.py"), original, "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: hello.py",
      " def greet():",
      '-    print("hello")',
      '+    print("hi")',
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));
    expect(result.isError).toBe(true);
    // 可读原因：期望内容 + 实际相近行 + 重试指引（模型可据此自我纠正）
    expect(result.output).toContain("hello.py");
    expect(result.output).toContain('print("hello")');
    expect(result.output).toContain('print("hello world")');
    expect(result.output).toContain("read_file");
    // 文件未被改动（拒绝是原子的）
    expect(readFileSync(join(workspace, "hello.py"), "utf8")).toBe(original);
  });

  it("纯新增行没有上下文/删除行：拒绝（无法定位）", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "a.txt"), "one\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "+two",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("上下文");
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("one\n");
  });

  it("同一文件多个补丁块按顺序应用", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "list.txt"), "a\nb\nc\nd\ne\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: list.txt",
      "@@",
      " a",
      "-b",
      "+B",
      "@@",
      " d",
      "-e",
      "+E",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));
    expect(result.isError).toBe(false);
    expect(readFileSync(join(workspace, "list.txt"), "utf8")).toBe(
      "a\nB\nc\nd\nE\n"
    );
  });

  it("Add File：新建文件（含父目录）；目标已存在则拒绝", async () => {
    const workspace = makeWorkspace();
    const patch = [
      "*** Begin Patch",
      "*** Add File: docs/new.md",
      "+# 标题",
      "+正文",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));
    expect(result.isError).toBe(false);
    expect(readFileSync(join(workspace, "docs", "new.md"), "utf8")).toBe(
      "# 标题\n正文\n"
    );

    const again = await tool.execute({ patch }, context(workspace));
    expect(again.isError).toBe(true);
    expect(again.output).toContain("已存在");
  });

  it("Delete File：删除成功；不存在拒绝", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "old.txt"), "x", "utf8");

    const del = await tool.execute(
      { patch: "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch" },
      context(workspace)
    );
    expect(del.isError).toBe(false);
    expect(existsSync(join(workspace, "old.txt"))).toBe(false);

    const missing = await tool.execute(
      { patch: "*** Begin Patch\n*** Delete File: ghost.txt\n*** End Patch" },
      context(workspace)
    );
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain("不存在");
  });

  it("多文件补丁：任一文件失配则整体不应用（原子性）", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "a.txt"), "aaa\n", "utf8");
    writeFileSync(join(workspace, "b.txt"), "bbb\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      " aaa",
      "-bbb",
      "+ccc",
      "*** Update File: b.txt",
      " bbb",
      "-zzz",
      "+yyy",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));
    expect(result.isError).toBe(true);
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("aaa\n");
    expect(readFileSync(join(workspace, "b.txt"), "utf8")).toBe("bbb\n");
  });

  it("重复目标即使使用 ./ 别名也整批拒绝，前面的其它文件零写入", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "duplicate.txt"), "one\ntwo\n");
    writeFileSync(join(workspace, "other.txt"), "original\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: other.txt",
      "-original",
      "+changed",
      "*** Update File: duplicate.txt",
      "-one",
      "+ONE",
      "*** Update File: ./duplicate.txt",
      "-two",
      "+TWO",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("重复");
    expect(readFileSync(join(workspace, "duplicate.txt"), "utf8")).toBe(
      "one\ntwo\n"
    );
    expect(readFileSync(join(workspace, "other.txt"), "utf8")).toBe(
      "original\n"
    );
  });

  it.each(["existing", "missing"])(
    "full-access 目录链接的 %s 真实目标重复时整批拒绝",
    async (kind) => {
      const workspace = makeWorkspace();
      const real = join(workspace, "real");
      mkdirSync(real);
      // Windows junction 不需要创建文件符号链接的管理员权限，不能吞 EPERM 假绿。
      symlinkSync(
        real,
        join(workspace, "alias"),
        process.platform === "win32" ? "junction" : "dir"
      );
      if (kind === "existing") {
        writeFileSync(join(real, "target.txt"), "one\ntwo\n");
      }
      const patch = [
        "*** Begin Patch",
        "*** Add File: untouched.txt",
        "+must-not-exist",
        ...(kind === "existing"
          ? [
              "*** Update File: real/target.txt",
              "-one",
              "+ONE",
              "*** Delete File: alias/target.txt",
            ]
          : [
              "*** Add File: real/nested/new.txt",
              "+one",
              "*** Add File: alias/nested/new.txt",
              "+two",
            ]),
        "*** End Patch",
      ].join("\n");

      const result = await tool.execute(
        { patch },
        { ...context(workspace), approvalMode: "full-access" }
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("重复");
      expect(existsSync(join(workspace, "untouched.txt"))).toBe(false);
      if (kind === "existing") {
        expect(readFileSync(join(real, "target.txt"), "utf8")).toBe(
          "one\ntwo\n"
        );
      } else {
        expect(existsSync(join(real, "nested"))).toBe(false);
      }
    }
  );

  it("full-access 悬空 file symlink 与真实目标同时 Add 时整批拒绝、零写（FS 边界）", async () => {
    const workspace = makeWorkspace();
    const metadata = join(workspace, "dangling-link-metadata");
    symlinkSync(
      join(workspace, "missing-directory"),
      metadata,
      process.platform === "win32" ? "junction" : "dir"
    );
    danglingFile.alias = join(workspace, "alias.txt");
    danglingFile.target = join(workspace, "real.txt");
    danglingFile.metadata = metadata;
    writeFileSync(join(workspace, "keep.txt"), "original\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: keep.txt",
      "-original",
      "+changed",
      "*** Add File: alias.txt",
      "+first",
      "*** Add File: real.txt",
      "+second",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute(
      { patch },
      { ...context(workspace), approvalMode: "full-access" }
    );

    expect.soft(result.isError).toBe(true);
    expect.soft(result.output).toContain("符号链接");
    expect.soft(existsSync(join(workspace, "real.txt"))).toBe(false);
    expect
      .soft(readFileSync(join(workspace, "keep.txt"), "utf8"))
      .toBe("original\n");
  });

  it("full-access 真实悬空 junction 后缀路径在任何写入前拒绝", async () => {
    const workspace = makeWorkspace();
    const target = join(workspace, "missing-directory");
    const alias = join(workspace, "dangling-directory");
    symlinkSync(
      target,
      alias,
      process.platform === "win32" ? "junction" : "dir"
    );
    const patch = [
      "*** Begin Patch",
      "*** Add File: untouched.txt",
      "+must-not-exist",
      "*** Add File: dangling-directory/nested/target.txt",
      "+content",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute(
      { patch },
      { ...context(workspace), approvalMode: "full-access" }
    );

    expect.soft(result.isError).toBe(true);
    expect.soft(result.output).toContain("符号链接");
    expect.soft(existsSync(join(workspace, "untouched.txt"))).toBe(false);
    expect.soft(existsSync(target)).toBe(false);
    // 同一个真实链接在目标建好后可达，证明不是把任意不存在路径当链接。
    mkdirSync(target);
    const reachable = await tool.execute(
      {
        patch:
          "*** Begin Patch\n*** Add File: dangling-directory/ok.txt\n+reachable\n*** End Patch",
      },
      { ...context(workspace), approvalMode: "full-access" }
    );
    expect(reachable.isError).toBe(false);
    expect(readFileSync(join(target, "ok.txt"), "utf8")).toBe("reachable\n");
  });

  it("hard link 的真实文件身份重复时拒绝 Update/Delete 混合", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "real.txt"), "original\n");
    linkSync(join(workspace, "real.txt"), join(workspace, "alias.txt"));
    const patch = [
      "*** Begin Patch",
      "*** Update File: real.txt",
      "-original",
      "+changed",
      "*** Delete File: alias.txt",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute(
      { patch },
      { ...context(workspace), approvalMode: "full-access" }
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("重复");
    expect(readFileSync(join(workspace, "real.txt"), "utf8")).toBe(
      "original\n"
    );
    expect(readFileSync(join(workspace, "alias.txt"), "utf8")).toBe(
      "original\n"
    );
  });

  it.skipIf(process.platform !== "win32")(
    "Windows 大小写及斜杠别名的新文件重复也零写入",
    async () => {
      const workspace = makeWorkspace();
      const patch = [
        "*** Begin Patch",
        "*** Add File: Folder/new.txt",
        "+one",
        "*** Add File: folder\\NEW.TXT",
        "+two",
        "*** End Patch",
      ].join("\n");

      const result = await tool.execute(
        { patch },
        { ...context(workspace), approvalMode: "full-access" }
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("重复");
      expect(existsSync(join(workspace, "Folder"))).toBe(false);
    }
  );

  it("格式非法（缺 Begin/End、段外杂行）拒绝并说明原因", async () => {
    const workspace = makeWorkspace();
    const noBegin = await tool.execute(
      { patch: "*** Update File: a.txt\n-x\n+y" },
      context(workspace)
    );
    expect(noBegin.isError).toBe(true);
    expect(noBegin.output).toContain("Begin Patch");

    const junk = await tool.execute(
      { patch: "*** Begin Patch\n随便一行\n*** End Patch" },
      context(workspace)
    );
    expect(junk.isError).toBe(true);
  });

  it("工作区外的文件操作被拒", async () => {
    const workspace = makeWorkspace();
    const patch = [
      "*** Begin Patch",
      "*** Add File: ../escape.txt",
      "+x",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("路径越界");
  });

  it("修改不存在的文件：提示先确认文件与上下文", async () => {
    const workspace = makeWorkspace();
    const patch = [
      "*** Begin Patch",
      "*** Update File: nope.txt",
      " context",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("nope.txt");
  });
});
