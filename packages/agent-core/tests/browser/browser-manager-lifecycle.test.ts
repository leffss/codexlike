import { chromium, type Browser } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBrowserTaskManager,
  type BrowserTaskManager,
} from "../../src/browser/manager";

// 仅替换 Playwright 外部边界，不启动浏览器、不触发下载。
vi.mock("playwright-core", () => ({ chromium: { launch: vi.fn() } }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class FakePage {
  closed = false;
  beforeClose = async () => {};
  constructor(readonly owner: FakeContext) {}
  isClosed() {
    return this.closed;
  }
  async close() {
    await this.beforeClose();
    this.closed = true;
  }
}

class FakeContext {
  closed = false;
  pages: FakePage[] = [];
  beforePage = async () => {};
  async newPage() {
    await this.beforePage();
    const page = new FakePage(this);
    this.pages.push(page);
    return page;
  }
  async close() {
    this.closed = true;
    await Promise.all(this.pages.map((page) => page.close()));
  }
}

class FakeBrowser {
  closed = false;
  contexts: FakeContext[] = [];
  beforeContext = async (_context: FakeContext) => {};
  isConnected() {
    return !this.closed;
  }
  async newContext() {
    const context = new FakeContext();
    this.contexts.push(context);
    await this.beforeContext(context);
    return context;
  }
  async close() {
    this.closed = true;
    await Promise.all(this.contexts.map((context) => context.close()));
  }
}

describe("BrowserTaskManager 并发生命周期（Playwright 边界）", () => {
  let manager: BrowserTaskManager;
  let browsers: FakeBrowser[];

  beforeEach(() => {
    browsers = [];
    vi.mocked(chromium.launch)
      .mockReset()
      .mockImplementation(async () => {
        const browser = new FakeBrowser();
        browsers.push(browser);
        return browser as unknown as Browser;
      });
    manager = createBrowserTaskManager({
      installer: {
        isReady: () => true,
        executablePath: () => "unused-fake-browser",
        install: async () => {
          throw new Error("测试禁止下载");
        },
      },
    });
  });

  afterEach(async () => {
    await manager.close();
  });

  it("newPage 失败关闭已创建 context，下次获取可重试", async () => {
    await manager.prepare();
    const browser = browsers[0]!;
    browser.beforeContext = async (context) => {
      context.beforePage = async () => {
        throw new Error("newPage failed");
      };
    };

    await expect(manager.pageFor("failed")).rejects.toThrow("newPage failed");
    expect(browser.contexts[0]!.closed).toBe(true);
    browser.beforeContext = async () => {};
    expect((await manager.pageFor("failed")).isClosed()).toBe(false);
  });

  it("当前页面被外部关闭后复用原 context 的 Cookie 状态，不遗留旧 context", async () => {
    const page = await manager.pageFor("closed-page");
    await page.close();

    const reopened = await manager.pageFor("closed-page");

    expect(reopened).not.toBe(page);
    expect(reopened.isClosed()).toBe(false);
    expect(browsers[0]!.contexts).toHaveLength(1);
    await manager.closeTask("closed-page");
    expect(browsers[0]!.contexts.every((context) => context.closed)).toBe(true);
  });

  it.each(["context", "page"] as const)(
    "closeTask 在 %s 创建中失效旧调用并回收迟到资源，新任务不受影响",
    async (stage) => {
      await manager.prepare();
      const browser = browsers[0]!;
      const entered = deferred();
      const gate = deferred();
      browser.beforeContext = async (context) => {
        if (stage === "context") {
          entered.resolve();
          await gate.promise;
        } else {
          context.beforePage = async () => {
            entered.resolve();
            await gate.promise;
          };
        }
      };
      const pending = manager.pageFor("closing");
      const settled = Promise.allSettled([pending]);
      await entered.promise;
      const closing = manager.closeTask("closing");
      browser.beforeContext = async () => {};
      const freshPromise = manager.pageFor("closing");
      gate.resolve();
      await closing;
      const fresh = await freshPromise;

      expect((await settled)[0]?.status).toBe("rejected");
      expect(browser.contexts[0]!.closed).toBe(true);
      expect(browser.contexts[0]!.pages.every((page) => page.closed)).toBe(
        true
      );
      expect(fresh.isClosed()).toBe(false);
      expect(await manager.pageFor("closing")).toBe(fresh);
    }
  );

  it("close 在 Chromium launch 进行中也回收迟到浏览器，并允许立即重开", async () => {
    const entered = deferred();
    const gate = deferred();
    const late = new FakeBrowser();
    vi.mocked(chromium.launch).mockImplementationOnce(async () => {
      browsers.push(late);
      entered.resolve();
      await gate.promise;
      return late as unknown as Browser;
    });
    const pending = manager.pageFor("late-launch");
    const settled = Promise.allSettled([pending]);
    await entered.promise;
    const closing = manager.close();
    const freshPromise = manager.pageFor("fresh-launch");
    gate.resolve();
    await closing;
    const fresh = await freshPromise;

    expect((await settled)[0]?.status).toBe("rejected");
    expect(late.closed).toBe(true);
    expect(fresh.isClosed()).toBe(false);
    expect(await manager.pageFor("fresh-launch")).toBe(fresh);
    await manager.close();
    expect(browsers.every((browser) => browser.closed)).toBe(true);
  });

  it("resetPage 关闭旧页期间 pageFor 与并发 reset 只观察同一新页", async () => {
    const old = await manager.pageFor("reset");
    const fake = browsers[0]!.contexts[0]!.pages[0]!;
    const entered = deferred();
    const gate = deferred();
    fake.beforeClose = async () => {
      entered.resolve();
      await gate.promise;
    };
    const reset = manager.resetPage("reset");
    await entered.promise;
    const reading = manager.pageFor("reset");
    const resetting = manager.resetPage("reset");
    gate.resolve();
    const [fresh, concurrentRead, concurrentReset] = await Promise.all([
      reset,
      reading,
      resetting,
    ]);

    expect(concurrentRead).toBe(fresh);
    expect(concurrentReset).toBe(fresh);
    expect(fresh).not.toBe(old);
    expect(old.isClosed()).toBe(true);
    expect(browsers[0]!.contexts).toHaveLength(1);
    expect(browsers[0]!.contexts[0]!.pages).toHaveLength(2);
  });

  it("resetPage 关闭旧页期间 closeTask 不会被迟到 reset 重新打开", async () => {
    await manager.pageFor("reset-close");
    const context = browsers[0]!.contexts[0]!;
    const entered = deferred();
    const gate = deferred();
    context.pages[0]!.beforeClose = async () => {
      entered.resolve();
      await gate.promise;
    };
    const reset = manager.resetPage("reset-close");
    const settled = Promise.allSettled([reset]);
    await entered.promise;
    const closing = manager.closeTask("reset-close");
    gate.resolve();
    await closing;

    expect((await settled)[0]?.status).toBe("rejected");
    expect(browsers[0]!.contexts.every((entry) => entry.closed)).toBe(true);
    expect((await manager.pageFor("reset-close")).isClosed()).toBe(false);
  });

  it("同一任务三个首次 pageFor 共享同一页面和 context，关闭后全部释放", async () => {
    const pages = await Promise.all(
      [1, 2, 3].map(() => manager.pageFor("task"))
    );

    expect(pages[1]).toBe(pages[0]);
    expect(pages[2]).toBe(pages[0]);
    expect(browsers[0]!.contexts).toHaveLength(1);
    await manager.closeTask("task");
    expect(pages.every((page) => page.isClosed())).toBe(true);
    expect(browsers[0]!.contexts.every((context) => context.closed)).toBe(true);
    const reopened = await manager.pageFor("task");
    expect(reopened).not.toBe(pages[0]);
    expect(reopened.isClosed()).toBe(false);
  });
});
