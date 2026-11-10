/**
 * 会话级浏览器生命周期（spec：浏览器实例会话级复用——同一会话共享上下文/Cookie，
 * 会话结束关闭）。全进程共享一个 headless Chromium，每个会话一个独立 BrowserContext
 * （Cookie/localStorage 互不串扰），context 内固定一个 Page（工具组的「当前页」）。
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

import {
  createCliChromiumInstaller,
  ensureChromiumReady,
  type ChromiumInstaller,
} from './chromium';

export interface BrowserSessionManagerOptions {
  /** Chromium 安装器（默认 CLI 实现；测试注入 fake） */
  installer?: ChromiumInstaller;
  /** 生命周期与下载进度输出（工具层据此向模型报告进度）；默认静默 */
  progress?: (line: string) => void;
  /** 传递给 chromium.launch 的额外选项（如代理、慢网络调试） */
  launchOptions?: Parameters<typeof chromium.launch>[0];
}

export interface BrowserSessionManager {
  /** 确保 Chromium 就绪（必要时下载安装）；onProgress 接收下载进度，缺省走构造时 progress */
  prepare(onProgress?: (line: string) => void): Promise<void>;
  /** 获取会话页面：首次调用确保 Chromium 就绪（必要时下载）并创建独立 context */
  pageFor(sessionId: string): Promise<Page>;
  /**
   * 丢弃会话当前页面、在同一 context 上开新页（Cookie 等状态保留）。
   * 导航失败后页面可能停在 chrome-error:// 并打断后续导航——整页换新是最可靠复位。
   */
  resetPage(sessionId: string): Promise<Page>;
  /** 会话结束：关闭其 context（页面与 Cookie 随之释放）；未打开的会话安全返回 */
  closeSession(sessionId: string): Promise<void>;
  /** 应用退出：关闭 Chromium 与全部会话 context；可重复调用 */
  close(): Promise<void>;
}

interface SessionEntry {
  context: BrowserContext;
  page: Page;
}

export function createBrowserSessionManager(
  options: BrowserSessionManagerOptions = {},
): BrowserSessionManager {
  const installer = options.installer ?? createCliChromiumInstaller();
  const progress = options.progress ?? (() => {});
  const sessions = new Map<string, SessionEntry>();

  let browser: Browser | null = null;
  let launchTask: Promise<Browser> | null = null;

  /** 首次使用前确保 Chromium 可执行就绪（未就绪自动下载，失败中文提示可重试） */
  async function launchBrowser(onProgress: (line: string) => void): Promise<Browser> {
    await ensureChromiumReady(installer, onProgress);
    onProgress('正在启动 Chromium…');
    return await chromium.launch({ headless: true, ...options.launchOptions });
  }

  function browserReady(onProgress: (line: string) => void): Promise<Browser> {
    if (browser !== null && browser.isConnected()) {
      return Promise.resolve(browser);
    }
    if (launchTask === null) {
      // 并发调用共享同一次启动；启动失败清空任务句柄，下次调用重试
      browser = null;
      sessions.clear();
      launchTask = launchBrowser(onProgress)
        .then((launched) => {
          browser = launched;
          return launched;
        })
        .finally(() => {
          launchTask = null;
        });
    }
    return launchTask;
  }

  return {
    async prepare(onProgress) {
      await browserReady(onProgress ?? progress);
    },

    async pageFor(sessionId) {
      const active = await browserReady(progress);
      const existing = sessions.get(sessionId);
      if (existing !== undefined && !existing.page.isClosed()) {
        return existing.page;
      }
      const context = await active.newContext();
      const page = await context.newPage();
      sessions.set(sessionId, { context, page });
      return page;
    },

    async closeSession(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry === undefined) {
        return;
      }
      sessions.delete(sessionId);
      await entry.context.close().catch(() => {});
    },

    async resetPage(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry === undefined) {
        return await this.pageFor(sessionId);
      }
      await entry.page.close({ runBeforeUnload: false }).catch(() => {});
      entry.page = await entry.context.newPage();
      return entry.page;
    },

    async close() {
      sessions.clear();
      const closing = browser;
      browser = null;
      await closing?.close().catch(() => {});
    },
  };
}
