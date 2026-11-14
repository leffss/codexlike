// 自绘标题栏：真实窗口状态、菜单移除、公共顶栏及空闲关闭保存。
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  assert,
  closeApp,
  launchApp,
  NARROW_WIDTH,
  untilDraft,
} from "./helpers.mjs";

const execFileAsync = promisify(execFile);

async function until(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    assert(Date.now() < deadline, message);
    await delay(25);
  }
}

/**
 * 渲染层元素中心 → 物理屏幕坐标（真实拖拽断言用）：内容区原点
 * （getContentBounds，DIP）+ 元素盒（CSS px 与 DIP 同值）按显示器缩放
 * 换算为物理像素。前置置顶（screen-saver 级）+ 聚焦，保证系统级输入命中
 * 本窗口而非遮挡物——实测本机环境下默认级别的 setAlwaysOnTop 不生效
 * （isAlwaysOnTop 仍为 false，输入被前景的其他窗口吃掉），screen-saver
 * 级别生效且 WindowFromPoint 验证命中（置顶由断言段收尾统一还原）。
 */
async function elementScreenPoint(app, locator) {
  const box = await locator.boundingBox();
  assert(box, "拖拽目标不可见");
  return app.evaluate(
    ({ BrowserWindow, screen }, point) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setAlwaysOnTop(true, "screen-saver");
      win.focus();
      win.moveTop();
      const bounds = win.getContentBounds();
      const display = screen.getDisplayMatching(bounds);
      return {
        x: Math.round(
          (bounds.x + point.x + point.width / 2) * display.scaleFactor
        ),
        y: Math.round(
          (bounds.y + point.y + point.height / 2) * display.scaleFactor
        ),
        scale: display.scaleFactor,
      };
    },
    { x: box.x, y: box.y, width: box.width, height: box.height }
  );
}

/**
 * 系统级真实拖拽（审查修复 2，去假绿）：-webkit-app-region 的窗口拖动由
 * 系统命中测试处理（Windows 命中 drag 区返回 HTCAPTION，按下即进入系统
 * 拖动循环），Playwright 合成鼠标事件只进渲染器输入管线、不走该路径——
 * 合成按下-移动-释放既不会移动窗口，事件本身也被 drag 区吞掉，仅断言
 * computed style 验证不了拖动行为。这里经 user32 注入与用户手势同路径的
 * 按下-渐进移动-释放（步距超过系统拖动阈值 SM_CXDRAG），拖动区与免拖
 * 控件两个方向都能验证。注入前两道环境修复（实测踩坑）：
 * ① PowerShell 进程默认被 DPI 虚拟化，SetCursorPos 的物理坐标按进程
 *   awareness 缩放（125% 下放大 1.25 倍、起点偏出拖动区），先置
 *   per-monitor aware；
 * ② 前景常有其他窗口遮挡（e2e 期间 Edge 等抢前台，Electron 的
 *   setAlwaysOnTop 默认级别实测不生效），先对目标窗口 HWND_TOPMOST
 *   硬置顶，并 WindowFromPoint 验证按下点确实命中本进程窗口，否则
 *   直接失败（不能让输入砸到无关窗口上）。
 */
async function nativeDrag(app, fromX, fromY, toX, toY) {
  const hwnd = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]
      .getNativeWindowHandle()
      .readBigUInt64LE(0)
      .toString()
  );
  const script = [
    `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public struct PT { public int X; public int Y; } public static class WinDrag { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, System.IntPtr dwExtraInfo); [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr after, int X, int Y, int cx, int cy, uint flags); [DllImport("user32.dll")] public static extern System.IntPtr WindowFromPoint(PT p); [DllImport("user32.dll")] public static extern System.IntPtr GetAncestor(System.IntPtr hWnd, uint flags); }'`,
    `if (-not [WinDrag]::SetProcessDpiAwarenessContext([System.IntPtr](-4))) { [void][WinDrag]::SetProcessDPIAware() }`,
    `$hitOk = $false`,
    `for ($try = 1; $try -le 10; $try++) { [void][WinDrag]::SetWindowPos([System.IntPtr]${hwnd}, [System.IntPtr](-1), 0, 0, 0, 0, 0x3); [void][WinDrag]::SetCursorPos(${fromX},${fromY}); Start-Sleep -Milliseconds 100; $pt = New-Object PT; $pt.X = ${fromX}; $pt.Y = ${fromY}; $hit = [WinDrag]::WindowFromPoint($pt); $hitRoot = [WinDrag]::GetAncestor($hit, 2); if ($hitRoot -eq [System.IntPtr]${hwnd}) { $hitOk = $true; break }; Start-Sleep -Milliseconds 200 }`,
    `if (-not $hitOk) { throw "拖拽起点 ${fromX},${fromY} 反复未命中应用窗口（宿主环境遮挡竞争），拒绝注入输入" }`,
    `[WinDrag]::mouse_event(2,0,0,0,[System.IntPtr]::Zero)`,
    `Start-Sleep -Milliseconds 120`,
    `for ($i = 1; $i -le 12; $i++) { [void][WinDrag]::SetCursorPos(${fromX} + [int]((${toX - fromX}) * $i / 12), ${fromY} + [int]((${toY - fromY}) * $i / 12)); Start-Sleep -Milliseconds 30 }`,
    `Start-Sleep -Milliseconds 150`,
    `[WinDrag]::mouse_event(4,0,0,0,[System.IntPtr]::Zero)`,
  ].join("\n");
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 30_000, windowsHide: true }
  );
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

    // ===== 真实拖拽断言（审查修复 2，去假绿）=====
    // 上面的 checkTitlebar 只断言 computed style（drag/no-drag 类名生效），
    // 验证不了拖动行为；这里补系统级真实输入的两个方向：
    // ① 拖动区（品牌回退态文本，跟随标题栏 drag 作用域）→ 窗口应移动；
    // ② 免拖控件（主题按钮）同样手势 → 窗口不得移动。
    assert(!(await nativeState(app)).maximized, "真实拖拽断言需要还原态窗口");
    {
      // 窄窗（压 minWidth 线外，与窄窗基线无关的隔离尺寸）放到工作区左上
      // 安全位：拖动终点留在屏内（1366 级小屏也不溢出），结束复原位置。
      const home = await app.evaluate(({ BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setContentSize(1010, 640);
        const { workArea } = screen.getPrimaryDisplay();
        win.setPosition(workArea.x + 16, workArea.y + 16);
        return win.getContentBounds();
      });
      // ① 拖动区：冷启动无任务，标题栏为品牌回退态（纯文本，可拖）
      const dragFrom = await elementScreenPoint(
        app,
        window
          .getByTestId("window-titlebar")
          .getByText("CodexLike", { exact: true })
      );
      const dragPx = { x: 150, y: 70 };
      await nativeDrag(
        app,
        dragFrom.x,
        dragFrom.y,
        dragFrom.x + dragPx.x,
        dragFrom.y + dragPx.y
      );
      // 窗口 bounds 是 DIP：物理位移按显示器缩放折算。系统拖动循环启动会
      // 吞掉首步移动（实测到位约 90% 期望位移），故按方向一致 + 位移达
      // 期望六成判定（no-drag 回退下位移恒为 0，同样能揭红）。
      const minDx = Math.round((dragPx.x / dragFrom.scale) * 0.6);
      const minDy = Math.round((dragPx.y / dragFrom.scale) * 0.6);
      await until(async () => {
        const bounds = await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].getContentBounds()
        );
        return bounds.x - home.x >= minDx && bounds.y - home.y >= minDy;
      }, "拖动区真实拖拽应移动窗口");
      // ② 免拖控件：同样手势不得移动窗口；按下-移出-释放不落在按钮上，
      // 也不误触主题切换（②有①作对照，SendInput 通道已被证明有效）
      const toggleBefore = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getContentBounds()
      );
      const toggleFrom = await elementScreenPoint(
        app,
        window.getByTestId("theme-toggle")
      );
      await nativeDrag(
        app,
        toggleFrom.x,
        toggleFrom.y,
        toggleFrom.x + dragPx.x,
        toggleFrom.y + dragPx.y
      );
      await delay(300);
      const toggleAfter = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getContentBounds()
      );
      assert(
        Math.abs(toggleAfter.x - toggleBefore.x) <= 2 &&
          Math.abs(toggleAfter.y - toggleBefore.y) <= 2,
        "免拖控件上真实拖拽不得移动窗口"
      );
      // 复原：窗口回原位并退出置顶，不影响后续场景
      await app.evaluate(
        ({ BrowserWindow }, pos) => {
          const win = BrowserWindow.getAllWindows()[0];
          win.setPosition(pos.x, pos.y);
          win.setAlwaysOnTop(false);
        },
        { x: home.x, y: home.y }
      );
    }

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
    // 窄窗基线（1100）的理由与取值归 helpers.mjs 的 NARROW_WIDTH 单点说明
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setContentSize(width, 640),
      NARROW_WIDTH
    );
    await window.waitForFunction(
      (width) => window.innerWidth === width,
      NARROW_WIDTH
    );
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
    await window.getByTestId("new-standalone-task-item").click();
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
    await window.getByTestId("new-standalone-task-item").click();
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
