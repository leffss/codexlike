import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureTestDataPaths } from "../../src/lifecycle/test-data-paths";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function applicationPaths() {
  const values = new Map<string, string>([
    ["userData", "original-user-data"],
    ["sessionData", "original-session-data"],
  ]);
  return {
    setPath(name: "userData" | "sessionData", path: string) {
      if (!existsSync(path)) throw new Error("Electron 路径必须先存在");
      values.set(name, path);
    },
    getPath(name: string) {
      return values.get(name);
    },
  };
}

describe("E2E Electron 数据目录隔离", () => {
  it("未显式开启测试路径时保留正常用户目录", () => {
    const app = applicationPaths();
    configureTestDataPaths(app, {});
    expect(app.getPath("userData")).toBe("original-user-data");
    expect(app.getPath("sessionData")).toBe("original-session-data");
  });

  it("首次启动自行创建独立用户目录与会话目录，重启沿用它们", () => {
    const root = mkdtempSync(join(tmpdir(), "codexlike-test-paths-"));
    temporary.push(root);
    const userData = join(root, "not-created", "electron-user-data");
    const env = { CODEXLIKE_TEST_USER_DATA: userData };
    const first = applicationPaths();
    configureTestDataPaths(first, env);
    expect(first.getPath("userData")).toBe(userData);
    expect(first.getPath("sessionData")).toBe(join(userData, "session"));
    const restarted = applicationPaths();
    configureTestDataPaths(restarted, env);
    expect(restarted.getPath("userData")).toBe(userData);
    expect(restarted.getPath("sessionData")).toBe(join(userData, "session"));
  });

  it("拒绝相对测试目录，不因启动 cwd 改变而写入不确定位置", () => {
    const app = applicationPaths();
    expect(() =>
      configureTestDataPaths(app, { CODEXLIKE_TEST_USER_DATA: "relative" })
    ).toThrow("绝对路径");
    expect(app.getPath("userData")).toBe("original-user-data");
  });
});
