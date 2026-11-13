// 自绘标题栏：真实窗口状态、菜单移除、公共顶栏及空闲关闭保存。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assert, closeApp, launchApp, untilDraft } from "./helpers.mjs";

async function until(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    assert(Date.now() < deadline, message);
    await delay(25);
  }
}

async function nativeState(app) {
  return app.evaluate(({ BrowserWindow, Menu }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return {
      maximized: win.isMaximized(),
      minimized: win.isMinimized(),
      menuRemoved: Menu.getApplicationMenu() === null,
      menuVisible: win.isMenuBarVisible(),
      resizable: win.isResizable(),
    };
  });
}

async function checkTitlebar(window) {
  for (const id of ["window-minimize", "window-maximize", "window-close"]) {
    const button = window.getByTestId(id);
    assert(await button.isVisible(), `${id} 应可见`);
    assert(await button.isEnabled(), `${id} 应可操作`);
    const bounds = await button.boundingBox();
    const width = await window.evaluate(() => window.innerWidth);
    assert(
      bounds && bounds.x >= 0 && bounds.x + bounds.width <= width,
      `${id} 不得溢出窗口`
    );
    assert(
      (await button.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("-webkit-app-region")
      )) === "no-drag",
      `${id} 不得被拖动区吞掉`
    );
  }
  assert(
    (await window
      .getByTestId("window-titlebar")
      .evaluate((el) =>
        getComputedStyle(el).getPropertyValue("-webkit-app-region")
      )) === "drag",
    "公共顶栏应提供拖动区"
  );
}

async function main() {
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-window-controls-"));
  let app;
  try {
    let window;
    ({ app, window } = await launchApp({ homeDir }));
    await window.getByTestId("window-close").waitFor();
    const initial = await nativeState(app);
    assert(
      initial.menuRemoved && !initial.menuVisible,
      "必须移除通用菜单，而非只自动隐藏"
    );
    assert(initial.resizable, "无边框窗口仍可调整大小");
    await checkTitlebar(window);

    await window.getByTestId("window-maximize").click();
    await until(
      async () => (await nativeState(app)).maximized,
      "点击最大化必须改变原生窗口状态"
    );
    await until(
      async () =>
        (await window
          .getByTestId("window-maximize")
          .getAttribute("aria-label")) === "还原",
      "最大化后按钮应显示还原"
    );
    await window.getByTestId("window-maximize").click();
    await until(
      async () => !(await nativeState(app)).maximized,
      "点击还原必须恢复原生窗口"
    );
    await until(
      async () =>
        (await window
          .getByTestId("window-maximize")
          .getAttribute("aria-label")) === "最大化",
      "还原后按钮应显示最大化"
    );

    // 模拟系统窗口操作，不经过按钮，验证宿主状态事件能同步界面。
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].maximize()
    );
    await until(
      async () =>
        (await window
          .getByTestId("window-maximize")
          .getAttribute("aria-label")) === "还原",
      "外部最大化必须同步按钮"
    );
    await window.reload();
    await until(
      async () =>
        (await window
          .getByTestId("window-maximize")
          .getAttribute("aria-label")) === "还原",
      "重载后应读取真实最大化初始状态"
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].unmaximize()
    );
    await until(
      async () =>
        (await window
          .getByTestId("window-maximize")
          .getAttribute("aria-label")) === "最大化",
      "外部还原必须同步按钮"
    );

    await window.getByTestId("window-minimize").click();
    await until(
      async () => (await nativeState(app)).minimized,
      "最小化必须改变原生窗口状态"
    );
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.restore();
      win.focus();
    });
    await until(
      async () => !(await nativeState(app)).minimized,
      "测试恢复窗口后应可继续操作"
    );

    await window.getByTestId("settings-open").click();
    await window.getByTestId("settings-back").waitFor();
    await checkTitlebar(window);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(640, 640)
    );
    await window.waitForFunction(() => window.innerWidth === 640);
    await checkTitlebar(window);
    const beforeTheme = await window.evaluate(
      () => document.documentElement.dataset.theme ?? "light"
    );
    await window.getByTestId("theme-toggle").click();
    await until(
      async () =>
        (await window.evaluate(
          () => document.documentElement.dataset.theme
        )) !== beforeTheme,
      "拖动区域不得阻止主题切换"
    );
    await checkTitlebar(window);
    await window.getByTestId("settings-back").click();
    await window.getByTestId("new-task").click();
    await window.getByTestId("composer-input").fill("自绘关闭按钮保留的草稿");
    await window.keyboard.press("Alt");
    assert(!(await nativeState(app)).menuVisible, "Alt 不得唤回通用菜单");

    const child = app.process();
    const done = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal }))
    );
    await window.getByTestId("window-close").click();
    let timer;
    const result = await Promise.race([
      done,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("自绘关闭按钮未正常结束进程")),
          15_000
        );
      }),
    ]).finally(() => clearTimeout(timer));
    assert(
      result.code === 0 && result.signal === null,
      "空闲关闭必须受控正常退出"
    );
    app = null;

    ({ app, window } = await launchApp({ homeDir }));
    await window.getByTestId("new-task").click();
    await untilDraft(
      window,
      "自绘关闭按钮保留的草稿",
      "自绘关闭应经过保存屏障"
    );
    await checkTitlebar(window);
    console.log(
      "PASS window-controls: 菜单移除、最小化、最大化/还原、外部状态/初始快照、设置/窄窗/主题、关闭保存"
    );
  } finally {
    await closeApp(app);
    rmSync(homeDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

main().catch((error) => {
  console.error("[e2e] 自绘窗口控制失败：", error);
  process.exitCode = 1;
});
