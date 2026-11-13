import { describe, expect, it } from "vitest";

import {
  screenshotPathFor,
  taskScreenshotDir,
} from "../../src/tasks/screenshots";

describe("会话截图路径约定（截图工具与读图 IPC 共用）", () => {
  it("目录与会话隔离：sessions/<会话id>/screenshots", () => {
    expect(taskScreenshotDir("C:\\data", "s-1")).toBe(
      "C:\\data\\sessions\\s-1\\screenshots"
    );
  });

  it("文件名取 toolCallId；非法路径字符被替换（IPC 边界不信任渲染进程）", () => {
    expect(screenshotPathFor("C:\\data", "s-1", "call-9")).toBe(
      "C:\\data\\sessions\\s-1\\screenshots\\call-9.png"
    );
    const hostile = screenshotPathFor("C:\\data", "s-1", "..\\..\\evil");
    expect(hostile.startsWith("C:\\data\\sessions\\s-1\\screenshots\\")).toBe(
      true
    );
    // 文件名部分不含路径分隔符：注入的 ..\ 无法逃出截图目录
    const name = hostile.split("\\").at(-1) ?? "";
    expect(name).not.toMatch(/[\\/]/);
    expect(name.endsWith(".png")).toBe(true);
  });
});
