/**
 * 任务级浏览器生命周期（spec：浏览器实例任务级复用——同一任务共享上下文/Cookie，
 * 任务结束关闭）。全进程共享一个 headless Chromium，每个任务一个独立 BrowserContext
 * （Cookie/localStorage 互不串扰），context 内固定一个 Page（工具组的「当前页」）。
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";

import {
  createCliChromiumInstaller,
  ensureChromiumReady,
  type ChromiumInstaller,
} from "./chromium";

export interface BrowserTaskManagerOptions {
  /** Chromium 安装器（默认 CLI 实现；测试注入 fake） */
  installer?: ChromiumInstaller;
  /** 生命周期与下载进度输出（工具层据此向模型报告进度）；默认静默 */
  progress?: (line: string) => void;
  /** 传递给 chromium.launch 的额外选项（如代理、慢网络调试） */
  launchOptions?: Parameters<typeof chromium.launch>[0];
}

export interface BrowserTaskManager {
  /** 确保 Chromium 就绪（必要时下载安装）；onProgress 接收下载进度，缺省走构造时 progress */
  prepare(onProgress?: (line: string) => void): Promise<void>;
  /** 获取任务页面：首次调用确保 Chromium 就绪（必要时下载）并创建独立 context */
  pageFor(taskId: string): Promise<Page>;
  /**
   * 丢弃任务当前页面、在同一 context 上开新页（Cookie 等状态保留）。
   * 导航失败后页面可能停在 chrome-error:// 并打断后续导航——整页换新是最可靠复位。
   */
  resetPage(taskId: string): Promise<Page>;
  /** 任务结束：关闭其 context（页面与 Cookie 随之释放）；未打开的任务安全返回 */
  closeTask(taskId: string): Promise<void>;
  /** 应用退出：关闭 Chromium 与全部任务 context；可重复调用 */
  close(): Promise<void>;
}

interface TaskEntry {
  context: BrowserContext | null;
  page: Page | null;
  browser: Browser | null;
  pending: Promise<Page> | null;
}

export function createBrowserTaskManager(
  options: BrowserTaskManagerOptions = {}
): BrowserTaskManager {
  const installer = options.installer ?? createCliChromiumInstaller();
  const progress = options.progress ?? (() => {});
  const tasks = new Map<string, TaskEntry>();
  const cleanups = new Set<Promise<void>>();

  let browser: Browser | null = null;
  let launchTask: Promise<Browser> | null = null;
  let generation = 0;

  /** 首次使用前确保 Chromium 可执行就绪（未就绪自动下载，失败中文提示可重试） */
  async function launchBrowser(
    onProgress: (line: string) => void
  ): Promise<Browser> {
    await ensureChromiumReady(installer, onProgress);
    onProgress("正在启动 Chromium…");
    return await chromium.launch({ headless: true, ...options.launchOptions });
  }

  function browserReady(onProgress: (line: string) => void): Promise<Browser> {
    if (browser !== null && browser.isConnected()) {
      return Promise.resolve(browser);
    }
    if (launchTask === null) {
      // 并发调用共享同一次启动；启动失败清空任务句柄，下次调用重试
      browser = null;
      const currentGeneration = generation;
      const operation = launchBrowser(onProgress)
        .then(async (launched) => {
          if (generation !== currentGeneration) {
            await launched.close().catch(() => {});
            throw new Error("浏览器已关闭，启动已取消");
          }
          browser = launched;
          return launched;
        })
        .finally(() => {
          if (launchTask === operation) launchTask = null;
        });
      launchTask = operation;
    }
    return launchTask;
  }

  function trackCleanup(operation: Promise<void>): Promise<void> {
    const cleanup = operation.finally(() => cleanups.delete(cleanup));
    cleanups.add(cleanup);
    return cleanup;
  }

  function closeEntry(entry: TaskEntry): Promise<void> {
    // 先关闭已持有的 context；创建中的迟到结果由创建方清理后才结算。
    return trackCleanup(
      Promise.all([
        entry.context?.close().catch(() => {}),
        entry.pending?.catch(() => {}),
      ]).then(() => undefined)
    );
  }

  function pageFor(taskId: string, reset = false): Promise<Page> {
    let entry = tasks.get(taskId);
    if (entry === undefined) {
      entry = { context: null, page: null, browser: null, pending: null };
      tasks.set(taskId, entry);
    }
    if (entry.pending !== null) return entry.pending;
    if (
      !reset &&
      entry.browser?.isConnected() &&
      entry.page !== null &&
      !entry.page.isClosed()
    ) {
      return Promise.resolve(entry.page);
    }
    const owner = entry;
    const current = () => tasks.get(taskId) === owner;
    const operation = (async () => {
      let context: BrowserContext | null = owner.context;
      try {
        const active = await browserReady(progress);
        if (!current()) throw new Error("任务浏览器已关闭，页面创建已取消");
        if (owner.browser !== active && context !== null) {
          await context.close().catch(() => {});
          context = null;
        }
        context ??= await active.newContext();
        if (!current()) throw new Error("任务浏览器已关闭，页面创建已取消");
        owner.context = context;
        owner.browser = active;
        if (reset) {
          await owner.page?.close({ runBeforeUnload: false }).catch(() => {});
          owner.page = null;
          if (!current()) throw new Error("任务浏览器已关闭，页面重置已取消");
        }
        const page = await context.newPage();
        if (!current()) {
          await page.close({ runBeforeUnload: false }).catch(() => {});
          throw new Error("任务浏览器已关闭，页面创建已取消");
        }
        owner.page = page;
        return page;
      } catch (error) {
        if (current()) tasks.delete(taskId);
        await context?.close().catch(() => {});
        throw error;
      }
    })().finally(() => {
      if (owner.pending === operation) owner.pending = null;
    });
    owner.pending = operation;
    return operation;
  }

  return {
    async prepare(onProgress) {
      await browserReady(onProgress ?? progress);
    },

    pageFor,

    async closeTask(taskId) {
      const entry = tasks.get(taskId);
      if (entry === undefined) return;
      tasks.delete(taskId);
      await closeEntry(entry);
    },

    resetPage(taskId) {
      return pageFor(taskId, true);
    },

    async close() {
      generation += 1;
      const entries = [...tasks.values()];
      tasks.clear();
      const active = browser;
      const launching = launchTask;
      browser = null;
      launchTask = null;
      const closing = trackCleanup(
        Promise.all([
          ...entries.map(closeEntry),
          active?.close().catch(() => {}),
          launching?.catch(() => {}),
        ]).then(() => undefined)
      );
      await Promise.all([...cleanups, closing]);
    },
  };
}
