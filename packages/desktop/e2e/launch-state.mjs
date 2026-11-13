// E2E（启动现场恢复，票01）：窗口 bounds / 最大化现场恢复 + 首启默认 + 损坏回退。
// ① 首启（无现场文件）：默认 1280×800，主屏工作区居中——现有冷启动行为不变
// ② 预写现场（正常 bounds）→ 启动位置与尺寸与文件一致（渲染层几何断言）
// ③ 负坐标与部分越界 bounds 照常恢复，不判失效
// ④ bounds 与所有现存显示器无交集 → 尺寸保留、位置主屏居中
// ⑤ maximized=true → 启动即最大化，取消最大化回到现场记录的正常态 bounds
// ⑥ 现场文件损坏 → 当未配置处理，默认 1280×800
//
// 断言单位：渲染层 window.screenX/screenY/outerWidth/outerHeight 在 DPI 缩放与
// 无框窗口隐形 resize 边框下与主进程 DIP bounds 差一个机器相关的恒定偏移
// （实测 125% 缩放：x-7 / y0 / 宽+14 / 高+7）。各场景用「启动 → 读渲染层与
// 主进程读数对 → 得单位差 delta → 重启 → 渲染层断言期望值+delta」：期望值
// 只来自现场文件与主屏 workArea（独立来源），delta 只是单位换算，不构成循环。
// 本 feature（票01）无写入路径：closeApp 后 launch-state.json 原样，重启可复现。
// 运行：node e2e/launch-state.mjs（需先 build）。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";

import { assert, closeApp, launchApp } from "./helpers.mjs";

/** 位置断言容差：DPI 取整（±1）与两次启动读数波动（位置单位差稳定） */
const TOLERANCE_POSITION = 3;
/**
 * 尺寸断言容差：Windows DPI 缩放下构造与 setBounds 两条路径的物理像素
 * 取整不同（125% 实测同宽差 6px），尺寸单位差有波动；±12 仍远小于任何
 * 行为差异（默认 1280 vs 恢复 900、最小收紧 400 vs 900）。
 */
const TOLERANCE_SIZE = 12;

/** 从渲染层读窗口几何（票面约定：screenX/screenY/outerWidth/outerHeight） */
async function geometry(window) {
  return window.evaluate(() => ({
    x: window.screenX,
    y: window.screenY,
    width: window.outerWidth,
    height: window.outerHeight,
  }));
}

async function primaryWorkArea(app) {
  return app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
}

async function windowBounds(app) {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds()
  );
}

async function maximized(app) {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].isMaximized()
  );
}

async function unmaximize(app) {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].unmaximize()
  );
}

/** 渲染层 outer 几何 ↔ 主进程 DIP bounds 的恒定单位差（同一窗口同时读两侧） */
async function unitDelta(app, window) {
  const renderer = await geometry(window);
  const main = await windowBounds(app);
  return {
    x: renderer.x - main.x,
    y: renderer.y - main.y,
    width: renderer.width - main.width,
    height: renderer.height - main.height,
  };
}

function near(actual, expected, tolerance, label) {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${label}：期望 ${expected}（±${tolerance}），实际 ${actual}`
  );
}

/** 渲染层域断言：期望 DIP bounds + 单位差（位置精确、尺寸放宽） */
function assertRendererBounds(actual, expectedDip, delta, label) {
  near(actual.x, expectedDip.x + delta.x, TOLERANCE_POSITION, `${label} x`);
  near(actual.y, expectedDip.y + delta.y, TOLERANCE_POSITION, `${label} y`);
  near(
    actual.width,
    expectedDip.width + delta.width,
    TOLERANCE_SIZE,
    `${label} 宽`
  );
  near(
    actual.height,
    expectedDip.height + delta.height,
    TOLERANCE_SIZE,
    `${label} 高`
  );
}

async function until(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    assert(Date.now() < deadline, message);
    await delay(50);
  }
}

async function launchWith(homeDir, fileContent) {
  if (fileContent !== undefined) {
    writeFileSync(join(homeDir, "launch-state.json"), fileContent);
  }
  const { app } = await launchApp({ homeDir });
  const window = app.windows()[0];
  await window.getByTestId("window-titlebar").waitFor();
  return { app, window };
}

/**
 * 单场景（homeDir 独立隔离）：
 * 第一次启动校准单位差（prepare 可先还原非最大化），重启后被测行为从渲染层断言。
 */
async function scenario(name, { fileContent, prepareCalibrate, verify }) {
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-launch-state-"));
  let delta;
  {
    const first = await launchWith(homeDir, fileContent);
    try {
      if (prepareCalibrate) await prepareCalibrate(first);
      delta = await unitDelta(first.app, first.window);
    } finally {
      await closeApp(first.app);
    }
  }
  const second = await launchWith(homeDir, fileContent);
  try {
    await verify({ ...second, delta });
    console.log(`[e2e] 启动现场 ${name}：OK`);
  } finally {
    await closeApp(second.app);
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

/** 主屏工作区居中的期望 DIP bounds */
function centeredOn(area, width, height) {
  return {
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
    width,
    height,
  };
}

async function main() {
  await scenario("① 首启默认 1280×800 主屏居中", {
    async verify({ app, window, delta }) {
      const area = await primaryWorkArea(app);
      assert(
        area.width >= 1280 && area.height >= 800,
        "测试环境主屏须容得下默认窗口"
      );
      const actual = await geometry(window);
      assertRendererBounds(
        actual,
        centeredOn(area, 1280, 800),
        delta,
        "首启默认"
      );
    },
  });

  await scenario("② 预写现场恢复位置与尺寸", {
    fileContent: JSON.stringify({
      bounds: { x: 100, y: 80, width: 900, height: 640 },
      maximized: false,
    }),
    async verify({ window, delta }) {
      assertRendererBounds(
        await geometry(window),
        { x: 100, y: 80, width: 900, height: 640 },
        delta,
        "预写现场恢复"
      );
    },
  });

  await scenario("③ 负坐标与部分越界照常恢复", {
    fileContent: JSON.stringify({
      bounds: { x: -200, y: -100, width: 900, height: 640 },
      maximized: false,
    }),
    async verify({ window, delta }) {
      assertRendererBounds(
        await geometry(window),
        { x: -200, y: -100, width: 900, height: 640 },
        delta,
        "负坐标恢复"
      );
    },
  });

  await scenario("④ 无交集：尺寸保留、主屏居中", {
    fileContent: JSON.stringify({
      bounds: { x: 20000, y: 20000, width: 900, height: 640 },
      maximized: false,
    }),
    async verify({ app, window, delta }) {
      const area = await primaryWorkArea(app);
      assertRendererBounds(
        await geometry(window),
        centeredOn(area, 900, 640),
        delta,
        "无交集回退"
      );
    },
  });

  await scenario("⑤ maximized 启动即最大化且还原回现场 bounds", {
    fileContent: JSON.stringify({
      bounds: { x: 140, y: 90, width: 960, height: 600 },
      maximized: true,
    }),
    async prepareCalibrate({ app }) {
      // 单位差须在非最大化状态读（最大化窗口无隐形 resize 边框）
      await unmaximize(app);
      await until(
        async () => !(await maximized(app)),
        "校准前取消最大化未生效"
      );
      await delay(300); // Windows 还原动画
    },
    async verify({ app, window, delta }) {
      await until(() => maximized(app), "预写 maximized=true 应启动即最大化");
      await unmaximize(app);
      // Windows 还原动画期间几何未稳定：轮询到达现场记录的正常态 bounds
      const expected = { x: 140, y: 90, width: 960, height: 600 };
      await until(async () => {
        const actual = await geometry(window);
        return (
          Math.abs(actual.x - (expected.x + delta.x)) <= TOLERANCE_POSITION &&
          Math.abs(actual.y - (expected.y + delta.y)) <= TOLERANCE_POSITION &&
          Math.abs(actual.width - (expected.width + delta.width)) <=
            TOLERANCE_SIZE &&
          Math.abs(actual.height - (expected.height + delta.height)) <=
            TOLERANCE_SIZE
        );
      }, "取消最大化后应回到现场记录的正常态 bounds");
    },
  });

  await scenario("⑥ 损坏现场当未配置，默认启动", {
    fileContent: "{oops",
    async verify({ app, window, delta }) {
      const area = await primaryWorkArea(app);
      const actual = await geometry(window);
      assertRendererBounds(
        actual,
        centeredOn(area, 1280, 800),
        delta,
        "损坏回退默认"
      );
    },
  });

  console.log(
    "[e2e] 启动现场恢复：首启默认、bounds/负坐标/无交集/最大化恢复、损坏回退 OK"
  );
}

main().catch((error) => {
  console.error("[e2e] 启动现场恢复失败：", error);
  process.exitCode = 1;
});
