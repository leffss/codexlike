import { describe, expect, it } from "vitest";

import { extractSkillNames } from "../../src/composer/skill-reference";
import { isSkillName } from "../../src/context/skill-name";

describe("extractSkillNames（显式技能引用）", () => {
  it("共享名称验证与显式引用一致：至少一个小写字母以排除金额歧义", () => {
    for (const name of ["a", "123-review", "review-456", "a".repeat(64)]) {
      expect(isSkillName(name), name).toBe(true);
      expect(extractSkillNames(`$${name}`)).toEqual([name]);
    }
    for (const name of [
      "",
      "123",
      "123-456",
      "Review",
      "bad--name",
      "bad_name",
      "-review",
      "review-",
      "a".repeat(65),
    ]) {
      expect(isSkillName(name), name).toBe(false);
      expect(extractSkillNames(`$${name}`)).toEqual([]);
    }
  });
  it("按出现顺序去重，并保留未知合法名供宿主报错", () => {
    expect(
      extractSkillNames(
        "使用 $code-review 和 $unknown-skill，再用 $code-review。"
      )
    ).toEqual(["code-review", "unknown-skill"]);
  });

  it("排除四列或 Tab 缩进代码，但保留普通前导空白和段落续行", () => {
    for (const indent of ["    ", "\t", "  \t", "     "]) {
      expect(extractSkillNames(`${indent}echo $path`)).toEqual([]);
      expect(
        extractSkillNames(
          `说明\n\n${indent}echo $path\n${indent}echo $next\n\n用 $review`
        )
      ).toEqual(["review"]);
    }
    expect(extractSkillNames("   请用 $review")).toEqual(["review"]);
    expect(extractSkillNames("请继续\n    使用 $review")).toEqual(["review"]);
    expect(extractSkillNames("    echo `$path\n\n用 $review")).toEqual([
      "review",
    ]);
  });

  it("跳过金额、转义、非法名称以及行内和两种围栏代码中的变量", () => {
    const text = [
      "$100 $12.50 \\$escaped $UPPER $bad_name $bad--name $bad- $a/b $good-name",
      "`$inline` ``echo `$nested` `` $outside",
      "```sh",
      "echo $shell",
      "```",
      "~~~shell",
      "$tilde",
      "~~~",
      `$${"a".repeat(65)} $${"b".repeat(64)}`,
    ].join("\n");
    expect(extractSkillNames(text)).toEqual([
      "good-name",
      "outside",
      "b".repeat(64),
    ]);
  });
});
