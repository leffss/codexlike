import { describe, expect, it } from "vitest";

import { extractSkillNames } from "../../src/composer/skill-reference";

import {
  resolveComposerSubmission,
  SLASH_COMMANDS,
} from "../../src/composer/parse";

/** 斜杠命令词汇表：七个内置命令，全部有中文描述（工单 07 + 08 /compact + ADR 0035 /goal） */
describe("SLASH_COMMANDS 命令表", () => {
  it("包含 /new /compact /rename /archive /model /status /goal 七个命令", () => {
    expect(SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "new",
      "compact",
      "rename",
      "archive",
      "model",
      "status",
      "goal",
    ]);
  });

  it("/goal 接受目标文本参数（GLOSSARY「目标」）：命令名与参数分离", () => {
    expect(resolveComposerSubmission("/goal 让示例测试全部通过")).toEqual({
      kind: "slash-command",
      name: "goal",
      argument: "让示例测试全部通过",
      raw: "/goal 让示例测试全部通过",
    });
    // 只输入命令名：参数为空串（由分发层给出用法提示）
    expect(resolveComposerSubmission("/goal")).toMatchObject({
      kind: "slash-command",
      name: "goal",
      argument: "",
    });
  });

  it("每个命令都有非空中文描述", () => {
    for (const command of SLASH_COMMANDS) {
      expect(command.description.length).toBeGreaterThan(0);
    }
  });
});

/** 发送时解析：一条输入要么是斜杠命令，要么是普通消息（可能携带 @引用） */
describe("resolveComposerSubmission（发送时解析）", () => {
  it("发送保留 Markdown 代码缩进，普通消息及内置命令仍按原 trim 语义", () => {
    for (const input of [
      "    echo $path",
      "\techo $path",
      "\n\n  \techo $path",
      "说明\n\n    echo $path",
    ]) {
      const submission = resolveComposerSubmission(input);
      expect(submission).toMatchObject({ kind: "message", text: input });
      if (submission?.kind === "message")
        expect(extractSkillNames(submission.text)).toEqual([]);
    }
    expect(resolveComposerSubmission("   请用 $review  ")).toEqual({
      kind: "message",
      text: "请用 $review",
      mentionPaths: [],
    });
    expect(resolveComposerSubmission("    /status  ")).toEqual({
      kind: "slash-command",
      name: "status",
      argument: "",
      raw: "/status",
    });
    expect(resolveComposerSubmission("   \t\n")).toBeNull();
  });
  it("空输入与纯空白输入返回 null（不可发送）", () => {
    expect(resolveComposerSubmission("")).toBeNull();
    expect(resolveComposerSubmission("   \n\t ")).toBeNull();
  });

  it("行首斜杠 + 已知命令名 → 斜杠命令，无参数", () => {
    const result = resolveComposerSubmission("/status");
    expect(result).toEqual({
      kind: "slash-command",
      name: "status",
      argument: "",
      raw: "/status",
    });
  });

  it("命令与参数之间允许任意空白，参数为剩余文本（trim 后）", () => {
    const result = resolveComposerSubmission("/rename   新任务名称  ");
    expect(result).toEqual({
      kind: "slash-command",
      name: "rename",
      argument: "新任务名称",
      raw: "/rename   新任务名称",
    });
  });

  it("命令名大小写不敏感（/STATUS 等效 /status）", () => {
    const result = resolveComposerSubmission("/STATUS");
    expect(result).toMatchObject({ kind: "slash-command", name: "status" });
  });

  it("未知斜杠词按普通消息处理（如发送 /etc/hosts 文本）", () => {
    const result = resolveComposerSubmission("/etc/hosts 里有什么");
    expect(result).toMatchObject({
      kind: "message",
      text: "/etc/hosts 里有什么",
      mentionPaths: [],
    });
  });

  it("斜杠不在行首（前面有文字）时不构成命令", () => {
    const result = resolveComposerSubmission("看看 /status 这个词");
    expect(result).toMatchObject({ kind: "message", mentionPaths: [] });
  });

  it("普通文本无 @ 引用时 mentionPaths 为空", () => {
    const result = resolveComposerSubmission("帮我修一下这个 bug");
    expect(result).toEqual({
      kind: "message",
      text: "帮我修一下这个 bug",
      mentionPaths: [],
    });
  });

  it("行首与空白后的 @token 提取为引用路径（保留出现顺序、去重）", () => {
    const result = resolveComposerSubmission(
      "看看 @src/a.ts 和 @docs/说明.md，再读 @src/a.ts 一遍"
    );
    expect(result).toMatchObject({
      kind: "message",
      mentionPaths: ["src/a.ts", "docs/说明.md"],
    });
  });

  it("@ 前是普通字符（邮箱）不构成引用", () => {
    const result = resolveComposerSubmission("联系 user@example.com 即可");
    expect(result).toMatchObject({ kind: "message", mentionPaths: [] });
  });

  it("消息文本保持原文（含 @token 本身），不做改写", () => {
    const raw = "请阅读 @README.md 并总结";
    const result = resolveComposerSubmission(raw);
    expect(result).toMatchObject({ kind: "message", text: raw });
  });
});
