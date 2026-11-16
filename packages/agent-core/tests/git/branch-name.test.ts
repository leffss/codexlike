import { describe, expect, it } from "vitest";

import { taskBranchName } from "../../src/git/branch-name";

describe("taskBranchName（任务标题 → 类型/slug 分支名）", () => {
  it("类型前缀启发：bug/缺陷/故障 → bug，修/fix/错误 → fix，其余 feature", () => {
    expect(taskBranchName("修复 login 页面 bug")).toBe("bug/login-bug");
    expect(taskBranchName("Fix timeout on upload")).toBe(
      "fix/fix-timeout-on-upload"
    );
    expect(taskBranchName("修复超时")).toBe("fix/task");
    expect(taskBranchName("Add login page")).toBe("feature/add-login-page");
    expect(taskBranchName("新增登录")).toBe("feature/task");
  });

  it("不含中文：中文等非 ASCII 成组替换为单个连字符，全中文回退 task", () => {
    expect(taskBranchName("重构 login 模块")).toBe("feature/login");
    // 「登录」剥除后 slug 只剩英文词 bug；slug 不剥类型关键词（简单优先）
    expect(taskBranchName("修复 登录 bug")).toBe("bug/bug");
    expect(taskBranchName("纯中文标题")).toBe("feature/task");
    expect(taskBranchName("")).toBe("feature/task");
    expect(taskBranchName("？？？")).toBe("feature/task");
  });

  it("git 非法字符与分隔符清理：空格/波浪号/冒号成组折叠，首尾连字符去除，统一小写", () => {
    expect(taskBranchName("fix: add x?")).toBe("fix/fix-add-x");
    expect(taskBranchName("  spaced   out  ")).toBe("feature/spaced-out");
    expect(taskBranchName("UPPER Case")).toBe("feature/upper-case");
    expect(taskBranchName("snake_case_name")).toBe("feature/snake-case-name");
  });

  it("整体长度 ≤50（含前缀与斜杠），前缀越长 slug 上限越紧", () => {
    const long = "a very long task title that keeps going and going and going";
    expect(taskBranchName(long).length).toBeLessThanOrEqual(50);
    expect(taskBranchName(long)).toBe(taskBranchName(long).replace(/-+$/, ""));
    // fix/ 4 字符 → slug ≤46（标题里的 fix 词不剥）；feature/ 8 字符 → slug ≤42
    expect(taskBranchName(`fix ${"x".repeat(60)}`)).toBe(
      "fix/fix-" + "x".repeat(42)
    );
    // 「修」命中 fix 关键词且剥除后不占 slug
    expect(taskBranchName(`修${"x".repeat(60)}`)).toBe("fix/" + "x".repeat(46));
    expect(taskBranchName("y".repeat(60))).toBe("feature/" + "y".repeat(42));
  });

  it("UUID 入参（worktree 会话分支）：原样保留为 feature/<uuid>", () => {
    const uuid = "1b671a64-40d5-491e-99b0-da01ff1f3341";
    expect(taskBranchName(uuid)).toBe(`feature/${uuid}`);
  });
});
