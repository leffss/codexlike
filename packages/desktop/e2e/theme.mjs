// E2E（ADR 0007 外观主题）：light / dark 切换 + 持久化。
// ① 首次启动默认浅色（html[data-theme=light]，未配置时 :root 即浅色）
// ② 顶栏快捷切换到深色 → html[data-theme=dark] 且 body 背景跟随
// ③ 重启 → 仍为深色（偏好落 ~/.codexlike/theme-settings.json）。
// 运行：node e2e/theme.mjs（需先 build）。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, closeApp, launchApp } from "./helpers.mjs";

async function themeOf(window) {
  return window.evaluate(
    () => document.documentElement.dataset.theme ?? "light"
  );
}

async function bodyBackground(window) {
  return window.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

async function assertComposerSurface(window, label) {
  const surface = await window
    .getByTestId("composer-region")
    .evaluate((element) => {
      const region = getComputedStyle(element);
      const card = document.querySelector('[data-testid="composer-card"]');
      const stream = getComputedStyle(
        document.querySelector('[data-testid="message-stream"]')
      );
      return {
        background: region.backgroundColor,
        streamBackground: stream.backgroundColor,
        borderTop: region.borderTopWidth,
        cardBorder: getComputedStyle(card).borderTopWidth,
      };
    });
  assert(
    surface.background === surface.streamBackground &&
      surface.borderTop === "0px",
    `${label}：输入区外围应与消息区同色且没有分隔线，实际 ${JSON.stringify(surface)}`
  );
  assert(
    parseFloat(surface.cardBorder) > 0,
    `${label}：输入卡片自身边框应保留`
  );
}

async function main() {
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-theme-"));

  try {
    // 1) 首次启动：未配置偏好 → 默认浅色
    const first = await launchApp({ homeDir });
    const window = first.window;
    // E2E 的 Electron userData（localStorage 所在）未随 homeDir 隔离：清掉此前
    // 运行残留的主题镜像并 reload，还原真实「未配置」首启（json 偏好已由 homeDir 隔离）
    await window.evaluate(() => localStorage.clear());
    await window.reload();
    assert(
      (await themeOf(window)) === "light",
      "未配置时应默认浅色（html[data-theme=light]）"
    );
    assert(
      (await bodyBackground(window)) === "rgb(255, 255, 255)",
      `浅色下 body 背景应为白色，实际 ${await bodyBackground(window)}`
    );

    await assertComposerSurface(window, "浅色");

    // 2) 顶栏快捷切换到深色：data-theme 与背景即时翻转
    await window.getByTestId("theme-toggle").click();
    assert((await themeOf(window)) === "dark", "点击切换后应为深色");
    assert(
      (await bodyBackground(window)) === "rgb(31, 30, 28)",
      `深色下 body 背景应为 canvas 色（暖深灰 #1f1e1c，ADR 0028），实际 ${await bodyBackground(window)}`
    );
    await assertComposerSurface(window, "深色");
    await closeApp(first.app);

    // 3) 重启：偏好持久化，仍为深色（无首帧回退——启动即 data-theme=dark）
    const second = await launchApp({ homeDir });
    assert(
      (await themeOf(second.window)) === "dark",
      "重启后应保持深色（theme-settings.json 持久化）"
    );
    const saved = JSON.parse(
      readFileSync(join(homeDir, "theme-settings.json"), "utf8")
    );
    assert(saved.theme === "dark", '落盘内容应为 {"theme":"dark"}');
    await closeApp(second.app);

    console.log("[e2e] 外观主题：默认浅色、顶栏切换、重启持久化 OK");
  } finally {
    // Windows 上 Electron 退出后短暂持有 homeDir 句柄（crashpad 等）；
    // 清理失败不掩盖 try 内的原始错误，尽力删即可
    try {
      rmSync(homeDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    } catch {
      console.warn(`[e2e] 临时目录清理失败（不影响结果）：${homeDir}`);
    }
  }
}

main().catch((error) => {
  console.error("[e2e] 外观主题冒烟失败：", error);
  process.exitCode = 1;
});
