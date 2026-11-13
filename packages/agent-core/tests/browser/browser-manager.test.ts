import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createBrowserTaskManager,
  type BrowserTaskManager,
} from "../../src/browser/manager";
import { startFixtureServer, type FixtureServer } from "./fixture-server";

/**
 * 真实 Chromium 的任务级生命周期测试（本机需有 playwright Chromium 缓存；
 * 首次拉起较慢，整个文件共享一次 launch）。
 */
describe("BrowserTaskManager（任务级浏览器实例）", () => {
  let manager: BrowserTaskManager;
  let fixture: FixtureServer;
  const log: string[] = [];

  beforeAll(async () => {
    fixture = await startFixtureServer();
    manager = createBrowserTaskManager({ progress: (line) => log.push(line) });
  }, 120_000);

  afterAll(async () => {
    await manager.close();
    await fixture.close();
  });

  it("同一任务的 pageFor 返回同一页面（任务内复用）", async () => {
    const page1 = await manager.pageFor("session-a");
    const page2 = await manager.pageFor("session-a");
    expect(page1).toBe(page2);
  }, 60_000);

  it("不同任务拿到不同 context：Cookie 互不共享", async () => {
    const pageA = await manager.pageFor("session-cookie-a");
    const pageB = await manager.pageFor("session-cookie-b");
    await pageA.goto(`${fixture.origin}/set-cookie`);
    const cookieA = await pageA.evaluate<string>("document.cookie");
    expect(cookieA).toContain("fixture_sid=abc123");
    await pageB.goto(`${fixture.origin}/form`);
    const cookieB = await pageB.evaluate<string>("document.cookie");
    expect(cookieB).not.toContain("fixture_sid");
  }, 60_000);

  it("closeTask 关闭该任务页面；再次 pageFor 得到全新页面（旧 Cookie 不残留）", async () => {
    const page = await manager.pageFor("session-recycled");
    await page.goto(`${fixture.origin}/set-cookie`);
    await manager.closeTask("session-recycled");
    // 旧 page 已关闭
    expect(page.isClosed()).toBe(true);
    const fresh = await manager.pageFor("session-recycled");
    expect(fresh).not.toBe(page);
    await fresh.goto(`${fixture.origin}/form`);
    const cookie = await fresh.evaluate<string>("document.cookie");
    expect(cookie).not.toContain("fixture_sid");
  }, 60_000);

  it("closeTask 对未知任务安全；close 幂等且清理全部任务", async () => {
    await expect(manager.closeTask("never-opened")).resolves.toBeUndefined();
    const page = await manager.pageFor("session-final");
    await manager.close();
    expect(page.isClosed()).toBe(true);
    await expect(manager.close()).resolves.toBeUndefined();
    // close 后可重新拉起（应用生命周期内 manager 不重建也可用）
    const revived = await manager.pageFor("session-after-close");
    expect(revived.isClosed()).toBe(false);
  }, 60_000);
});
