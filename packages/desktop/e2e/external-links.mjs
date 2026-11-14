// 真实 assistant Markdown 外链：只替换系统浏览器边界，不代替产品导航防护。
// 先收集全部症状再失败，确保 URL 改变不会遮蔽标题栏丢失及正常关闭挂起。
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assert, closeApp, launchApp, startMockProvider } from "./helpers.mjs";

const LINK_LABEL = "打开本地外链验证页";
const PROMPT = "请返回一个供点击验证的 Markdown HTTP 链接";
const DRAFT = "点击外链后仍应保留的未发送草稿";
const CLOSE_TIMEOUT = 15_000;

function evidence(stage, value) {
  console.log(`[external-links] ${stage} ${JSON.stringify(value)}`);
}

// 被产品取消的主 frame 导航会留下未提交的导航请求，Playwright 的等待型 locator
// 调用（含 boundingBox/locator.evaluate）会永久停在 waiting for navigation to
// finish；边界场景涉及被取消导航，之后的渲染进程交互一律走 evaluate + 原始鼠标输入。
async function rawClick(window, testId) {
  const rect = await window.evaluate((id) => {
    const node = document.querySelector(`[data-testid="${id}"]`);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2
    );
    return {
      clickable:
        box.width > 0 && box.height > 0 && (node === hit || node.contains(hit)),
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
    };
  }, testId);
  assert(rect?.clickable, `${testId} 必须可见且中心点可命中`);
  await window.mouse.click(rect.x, rect.y);
}

async function nativeSnapshot(app, mainWindowId) {
  return app.evaluate(({ BrowserWindow }, id) => {
    const main = BrowserWindow.fromId(id);
    return {
      mainWindowId: id,
      url: main?.webContents.getURL() ?? null,
      title: main?.getTitle() ?? null,
      loading: main?.webContents.isLoading() ?? false,
      windows: BrowserWindow.getAllWindows().map((win) => ({
        id: win.id,
        url: win.webContents.getURL(),
      })),
      externalCalls: [...globalThis.externalLinksCalls],
      dialogs: [...globalThis.externalLinksDialogs],
    };
  }, mainWindowId);
}

// 同样绕开 locator 等待：单次 evaluate 直读 DOM，语义与 isVisible/isEditable/
// inputValue 对齐（非零占位盒、控件可编辑、取 value）。
async function workbenchSnapshot(window) {
  return window.evaluate(() => {
    const node = (id) => document.querySelector(`[data-testid="${id}"]`);
    const visible = (el) => !!el && el.getClientRects().length > 0;
    const composer = node("composer-input");
    return {
      titlebarVisible: visible(node("window-titlebar")),
      closeVisible: visible(node("window-close")),
      assistantVisible: visible(node("message-assistant")),
      userVisible: visible(node("message-user")),
      composerVisible: visible(composer),
      composerEditable:
        visible(composer) && !composer.disabled && !composer.readOnly,
      draft: composer ? composer.value : null,
    };
  });
}

/** 独立于 closeApp 清理的退出证据；只有真实 exit(0, null) 才算正常退出。 */
async function attemptNormalClose(app, window, mainWindowId, closeVisible) {
  const child = app.process();
  assert(
    child.exitCode === null && child.signalCode === null,
    "关闭操作前应用进程必须仍在运行"
  );
  let onExit;
  let timer;
  const done = new Promise((resolve) => {
    onExit = (code, signal) => resolve({ exited: true, code, signal });
    child.once("exit", onExit);
    timer = setTimeout(
      () =>
        resolve({
          exited: false,
          code: child.exitCode,
          signal: child.signalCode,
        }),
      CLOSE_TIMEOUT
    );
  });
  const method = closeVisible ? "window-close.click" : "BrowserWindow.close";
  evidence("normal-close-request", {
    method,
    timeoutMs: CLOSE_TIMEOUT,
    pid: child.pid,
  });
  try {
    if (closeVisible) {
      await rawClick(window, "window-close");
    } else {
      // 标题栏丢失时仍尝试原生关闭；不调用 destroy/app.exit，也不伪造保存回执。
      await app.evaluate(({ BrowserWindow }, id) => {
        BrowserWindow.fromId(id).close();
      }, mainWindowId);
    }
    const result = { method, ...(await done) };
    evidence("normal-close-result", result);
    if (!result.exited)
      evidence("after-close-timeout", await nativeSnapshot(app, mainWindowId));
    return result;
  } finally {
    clearTimeout(timer);
    child.off("exit", onExit);
  }
}

// 原生 DOM fixture 刻意在 React 根节点之外，验证不是 Markdown 组件独自挡住导航。
// 点击始终由 Playwright 发起；不 dispatchEvent、不调用策略内部函数。
async function checkHostBoundaries({
  app,
  window,
  mainWindowId,
  entryURL,
  targetURL,
  check,
}) {
  const cases = [
    { name: "native-self-http", url: targetURL, mode: "self", opens: true },
    {
      name: "native-popup-https",
      url: "https://example.invalid/external-link-e2e",
      mode: "open",
      opens: true,
    },
    {
      name: "blocked-self-file",
      url: new URL("blocked-e2e.html", entryURL).href,
      mode: "self",
    },
    {
      name: "blocked-popup-file",
      url: new URL("blocked-e2e.html", entryURL).href,
      mode: "open",
    },
    {
      name: "blocked-popup-data",
      url: "data:text/html,external-link-e2e",
      mode: "open",
    },
    {
      name: "blocked-popup-javascript",
      url: "javascript:void(0)",
      mode: "open",
    },
    {
      name: "blocked-popup-custom",
      url: "codexlike-e2e-unknown://blocked",
      mode: "open",
    },
    {
      name: "open-external-reject",
      url: targetURL,
      mode: "self",
      opens: true,
      reject: true,
    },
  ];
  for (const scenario of cases) {
    const before = await nativeSnapshot(app, mainWindowId);
    await app.evaluate((_, reject) => {
      globalThis.externalLinksReject = reject;
    }, Boolean(scenario.reject));
    await window.evaluate(({ url, mode }) => {
      document
        .querySelector('[data-testid="external-boundary-fixture"]')
        ?.remove();
      // 不用 window.open：被产品 setWindowOpenHandler 拒绝后 Playwright 的渲染进程
      // 调用会停在等待导航；target=_blank 与 window.open 汇入同一 handler，
      // handler 的 window.open 形态由 navigation-policy 单元测试直接覆盖。
      const control = document.createElement("a");
      control.dataset.testid = "external-boundary-fixture";
      control.dataset.clicks = "0";
      control.textContent = "E2E 原生导航边界";
      control.style.cssText =
        "position:fixed;left:20px;top:100px;z-index:2147483647;background:white;color:black;padding:16px";
      control.href = url;
      control.target = mode === "self" ? "_self" : "_blank";
      // 对齐产品 Markdown 链接的真实输出属性。
      control.rel = "noopener noreferrer";
      control.addEventListener("click", () => {
        control.dataset.clicks = String(Number(control.dataset.clicks) + 1);
      });
      document.body.append(control);
    }, scenario);
    // 真实鼠标输入命中控件中心；被取消的导航会让等待型 locator 卡死，见 rawClick 注释。
    await rawClick(window, "external-boundary-fixture");
    let after;
    const deadline = Date.now() + (scenario.opens ? 3000 : 500);
    // 拒绝路径没有正向完成回执，观察整个短窗口，不能用瞬时零调用判绿。
    do {
      after = await nativeSnapshot(app, mainWindowId);
      if (
        scenario.opens &&
        after.externalCalls.length > before.externalCalls.length &&
        (!scenario.reject || after.dialogs.length > before.dialogs.length)
      )
        break;
      await delay(25);
    } while (Date.now() < deadline);
    const ui = await workbenchSnapshot(window);
    const calls = after.externalCalls.slice(before.externalCalls.length);
    const dialogs = after.dialogs.slice(before.dialogs.length);
    evidence(scenario.name, {
      url: after.url,
      windows: after.windows,
      calls,
      dialogs,
      ui,
    });
    check(after.url === entryURL, `${scenario.name}: 主窗口必须保持应用入口`);
    check(
      after.windows.length === 1 && after.windows[0].id === mainWindowId,
      `${scenario.name}: 不得创建 Electron 子窗口`
    );
    check(
      ui.titlebarVisible &&
        ui.closeVisible &&
        ui.assistantVisible &&
        ui.composerEditable &&
        ui.draft === `${DRAFT}（继续编辑）`,
      `${scenario.name}: 工作台及草稿必须保留`
    );
    check(
      scenario.opens
        ? calls.length === 1 && calls[0] === scenario.url
        : calls.length === 0,
      `${scenario.name}: 外部打开次数及目标必须符合策略`
    );
    check(
      scenario.reject
        ? dialogs.length === 1 &&
            dialogs[0].type === "warning" &&
            dialogs[0].title === "无法打开链接" &&
            dialogs[0].message === "无法在默认浏览器中打开链接，请稍后重试。"
        : dialogs.length === 0,
      `${scenario.name}: 失败时必须提示且不回退导航`
    );
    if (after.url !== entryURL) break;
    const clicks = await window.evaluate(
      (id) =>
        document.querySelector(`[data-testid="${id}"]`)?.dataset.clicks ?? null,
      "external-boundary-fixture"
    );
    check(clicks === "1", `${scenario.name}: 必须经过一次真实控件点击`);
    await window.evaluate(
      (id) => document.querySelector(`[data-testid="${id}"]`)?.remove(),
      "external-boundary-fixture"
    );
  }
  await app.evaluate(() => {
    globalThis.externalLinksReject = false;
  });
}

async function main() {
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-external-links-"));
  const targetRequests = [];
  let model;
  let app;
  try {
    model = await startMockProvider(
      (ctx) => {
        ctx.textRound(
          `[${LINK_LABEL}](http://127.0.0.1:${ctx.port}/external-target)`
        );
      },
      (req, res) => {
        if (req.method !== "GET" || req.url !== "/external-target")
          return false;
        targetRequests.push({ method: req.method, path: req.url });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        // 不注入任何关闭/导航脚本：这就是一个替换工作台后无法握手的普通网页。
        res.end(
          "<!doctype html><html><head><title>External link target</title></head><body><h1>External link target</h1></body></html>"
        );
        return true;
      }
    );
    const targetURL = `http://127.0.0.1:${model.port}/external-target`;
    let window;
    ({ app, window } = await launchApp({ homeDir }));
    window.setDefaultTimeout(3000);
    await window.getByTestId("new-task").waitFor();
    const mainWindow = await app.browserWindow(window);
    const mainWindowId = await mainWindow.evaluate((win) => win.id);
    // 只替换 OS 打开/原生提示边界，不注册或替换任何产品导航处理器。
    await app.evaluate(({ shell, dialog }) => {
      globalThis.externalLinksCalls = [];
      globalThis.externalLinksDialogs = [];
      globalThis.externalLinksReject = false;
      shell.openExternal = async (url) => {
        globalThis.externalLinksCalls.push(url);
        if (globalThis.externalLinksReject)
          throw new Error("E2E simulated openExternal failure");
      };
      dialog.showMessageBox = async (options) => {
        globalThis.externalLinksDialogs.push(options);
        return { response: 0, checkboxChecked: false };
      };
    });
    const navigations = [];
    window.on("framenavigated", (frame) => {
      if (frame === window.mainFrame()) navigations.push(frame.url());
    });

    // 通过已有公开配置入口接入 mock；发送、消息渲染和链接点击都走真实 UI。
    await window.evaluate(async (port) => {
      await window.codexlike.providerProfiles.create({
        name: "External Links Mock",
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: "test",
        model: "mock-model",
      });
    }, model.port);
    await window.getByTestId("settings-open").click();
    await window.getByTestId("settings-back").click();
    await window.getByTestId("new-task").click();
    await window.getByTestId("new-standalone-task-item").click();
    await window.getByTestId("composer-input").fill(PROMPT);
    await window.getByTestId("composer-send").click();
    const assistant = window.getByTestId("message-assistant");
    const link = assistant.getByRole("link", { name: LINK_LABEL, exact: true });
    await link.waitFor();
    await window.getByTestId("composer-send").waitFor();
    assert(
      model.requestCount() === 1,
      "链接必须来自一次真实模型请求的 assistant 回复"
    );
    assert((await link.count()) === 1, "assistant 回复应只有一个目标链接");
    assert(
      (await link.getAttribute("href")) === targetURL,
      "真实 Markdown 渲染出的 href 应指向本地目标页"
    );
    await window.getByTestId("composer-input").fill(DRAFT);
    const before = await nativeSnapshot(app, mainWindowId);
    const beforeUI = await workbenchSnapshot(window);
    evidence("before-click", {
      ...before,
      ui: beforeUI,
      targetURL,
      modelRequests: model.requestCount(),
    });
    assert(before.windows.length === 1, "点击前只有主窗口");
    assert(
      beforeUI.titlebarVisible &&
        beforeUI.closeVisible &&
        beforeUI.assistantVisible &&
        beforeUI.userVisible &&
        beforeUI.composerEditable,
      "点击前工作台和关闭入口完整可用"
    );

    await link.click();
    // 等待真实导航完成或系统打开调用，不能仅凭 click 返回立即判定安全。
    const deadline = Date.now() + 5000;
    let after;
    do {
      after = await nativeSnapshot(app, mainWindowId);
      if (
        !after.loading &&
        (after.url !== before.url ||
          after.externalCalls.length > 0 ||
          after.windows.length !== 1)
      )
        break;
      await delay(25);
    } while (Date.now() < deadline);
    const afterUI = await workbenchSnapshot(window);
    evidence("after-click", {
      ...after,
      ui: afterUI,
      navigations,
      targetRequests,
    });

    // 软断言只为收齐独立证据，不把已知失败吞掉或改成预期成功。
    const failures = [];
    const check = (condition, message) => {
      if (!condition) {
        failures.push(message);
        console.error(`[external-links] FAIL ${message}`);
      }
    };
    check(after.url === before.url, "点击外链后主窗口 URL 必须保持应用入口");
    check(
      navigations.every((url) => url === before.url),
      "主 frame 不得曾导航到外部文档"
    );
    check(
      afterUI.titlebarVisible && afterUI.closeVisible,
      "点击外链后自绘标题栏及关闭按钮必须保留"
    );
    check(
      afterUI.assistantVisible && afterUI.userVisible,
      "点击外链后原任务消息必须保留"
    );
    check(
      afterUI.composerEditable && afterUI.draft === DRAFT,
      "点击外链后输入框可编辑且未发送草稿保留"
    );
    check(
      after.windows.length === 1 && after.windows[0].id === mainWindowId,
      "外链不得创建额外 Electron 窗口"
    );
    check(
      after.externalCalls.length === 1 && after.externalCalls[0] === targetURL,
      "一次点击必须恰好调用一次 shell.openExternal 打开目标 URL"
    );
    check(
      targetRequests.length === 0,
      "系统打开被替换时 Electron 不应请求外部目标文档"
    );

    if (afterUI.composerEditable && afterUI.titlebarVisible) {
      try {
        await window.getByTestId("composer-input").fill(`${DRAFT}（继续编辑）`);
        await window.getByTestId("settings-open").click();
        await window.getByTestId("settings-back").click();
        check(
          (await window.getByTestId("composer-input").inputValue()) ===
            `${DRAFT}（继续编辑）`,
          "点击外链后编辑及设置往返必须保持可用"
        );
      } catch (error) {
        check(false, `点击外链后工作台交互失败：${error.message}`);
      }
    }
    if (failures.length === 0) {
      try {
        await checkHostBoundaries({
          app,
          window,
          mainWindowId,
          entryURL: before.url,
          targetURL,
          check,
        });
        check(navigations.length === 0, "边界场景不得发生主 frame 文档替换");
        check(
          targetRequests.length === 0,
          "边界场景不得由 Electron 请求外部目标文档"
        );
      } catch (error) {
        check(false, `导航边界场景失败：${error.message}`);
      }
    }
    // 边界场景后不再使用等待型 locator；关闭入口可见性沿用同一直读快照。
    const closeVisible = (await workbenchSnapshot(window)).closeVisible;
    const closed = await attemptNormalClose(
      app,
      window,
      mainWindowId,
      closeVisible
    );
    // 进程已退出时 Playwright 连接随之释放，app.process() 会抛内部错误；
    // 置空沿用 window-controls 的收尾约定，finally 只清理仍在运行的实例。
    if (closed.exited) app = null;
    check(
      closed.exited && closed.code === 0 && closed.signal === null,
      `正常关闭必须在 ${CLOSE_TIMEOUT}ms 内 exit(0, null)，清理强杀不算成功`
    );
    assert(
      failures.length === 0,
      `external-links 共 ${failures.length} 项失败：${failures.join("；")}`
    );
    console.log(
      "PASS external-links: 真实 assistant HTTP 链接、系统打开一次、工作台保留、无新窗口、正常关闭"
    );
  } finally {
    try {
      if (app) {
        const child = app.process();
        evidence("cleanup", {
          pid: child.pid,
          running: child.exitCode === null && child.signalCode === null,
          countsAsNormalClose: false,
        });
      }
      await closeApp(app);
      // Windows 强杀后的文件句柄释放可能稍晚；异步重试不阻塞进程收尾事件。
      // 清理失败也置非零退出码，但不能覆盖已经收集的导航/关闭断言。
      await rm(homeDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 300,
      }).catch((error) => {
        console.error(`[external-links] 临时目录清理失败 ${homeDir}`, error);
        process.exitCode = 1;
      });
    } finally {
      if (model) {
        model.server.closeAllConnections();
        await new Promise((resolve) => model.server.close(resolve));
      }
    }
  }
}

main().catch((error) => {
  console.error("[e2e] external-links 失败：", error);
  process.exitCode = 1;
});
