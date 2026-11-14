// E2E 浏览器工具（工单 11）：启动真实 Electron 应用 → mock 模型依次调用
// browser_navigate（打开本 E2E 自带的 fixture 页）→ browser_screenshot（整页截图）
// → 最终文本。断言：工具卡片渲染、截图真实落盘到任务数据目录、截图卡片内嵌图片
// （IPC 读回 dataURL）回填给模型的 tool result 为文本降级（未设附图开关）。
// 运行：pnpm test:e2e:browser（先全仓 build；本机需已有 Chromium 缓存或首次自动下载）。
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  assert,
  closeApp,
  launchApp,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

/** 浏览器工具要抓取的 fixture 页（标题与正文唯一，便于断言） */
const FIXTURE_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>E2E 浏览器页</title></head>
<body><h1>浏览器工具 E2E</h1><p>fixture 正文内容 browser-e2e-ok</p></body></html>`;

/**
 * 一个端口同时提供：
 * - GET /page：浏览器 fixture 页
 * - POST /v1/chat/completions：OpenAI 兼容 mock——第 1 轮 browser_navigate、
 *   第 2 轮 browser_screenshot、之后流式文本；请求体由骨架记录供断言。
 */
async function main() {
  const {
    server,
    port,
    seenBodies: receivedBodies,
  } = await startMockProvider(
    (ctx, { index }) => {
      if (index === 1) {
        ctx.toolCallRound("call-e2e-nav", "browser_navigate", {
          url: `http://127.0.0.1:${ctx.port}/page`,
        });
        return;
      }
      if (index === 2) {
        ctx.toolCallRound("call-e2e-shot", "browser_screenshot", {});
        return;
      }
      ctx.textChunksRound(["截图已收到，", "浏览器工具链路 OK"]);
    },
    (req, res) => {
      if (req.method !== "GET" || req.url !== "/page") {
        return false;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
      return true;
    }
  );
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-browser-"));
  mkdirSync(join(homeDir, "workspace"));

  let app;
  try {
    // 1) 预置 Profile + 建任务
    const launched = await launchApp({ homeDir });
    app = launched.app;
    const window = launched.window;
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const profileForm = window.locator("form");
    await profileForm.getByLabel("名称").fill("Mock");
    await profileForm.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel("API Key").fill("sk-e2e");
    await profileForm.getByLabel("模型").fill("mock-model");
    // 设置页有多个「保存」按钮（Profile 表单与搜索源区），限定在表单内点击
    await profileForm.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Mock").first().waitFor();
    await window.getByTestId("settings-back").click();
    await prepareDraft(window, { approvalMode: "assist" });
    console.log("[e2e] 应用启动、Profile 与任务就绪");

    // 2) 发消息 → mock 模型依次调 navigate / screenshot
    await window.getByTestId("composer-input").fill("打开 fixture 页并截图");
    await window.getByTestId("composer-send").click();

    // navigate 卡片渲染即证明工具链路真实启动（运行中的工具卡默认展开，
    // 卡片可见，ADR 0015）。轮完成后工具卡自动收起为摘要行——卡片与输出
    // 仍在 DOM（收起态不渲染展开区），等轮完成（composer-send 恢复为空闲
    // 确定信号）后点击卡头展开，再对两张卡片做输出断言。
    const navCard = window.locator(
      '[data-testid="tool-call-card"][data-tool-name="browser_navigate"]'
    );
    await navCard.waitFor({ timeout: 60_000 });
    await window.getByTestId("composer-send").waitFor({ timeout: 60_000 });

    // navigate 卡片：真实 Chromium 打开 fixture，输出含页面标题
    await navCard.getByTestId("tool-call-toggle").click();
    await navCard
      .getByText("已打开「E2E 浏览器页」")
      .waitFor({ timeout: 60_000 });
    console.log("[e2e] browser_navigate 在 Electron 主进程内真实执行");

    // screenshot 卡片：输出含保存路径，且卡片内嵌截图图片（IPC 读回 dataURL）
    const shotCard = window.locator(
      '[data-testid="tool-call-card"][data-tool-name="browser_screenshot"]'
    );
    await shotCard.getByTestId("tool-call-toggle").click();
    await shotCard.getByText("整页截图已保存").waitFor({ timeout: 60_000 });
    await shotCard
      .getByTestId("tool-call-screenshot")
      .waitFor({ timeout: 60_000 });
    console.log("[e2e] 截图卡片内嵌图片渲染（写盘 → toolImage IPC → img）");

    // 3) 截图真实落盘到任务数据目录（约定路径，票 03 换 tasks 系）
    const tasksDir = join(homeDir, "tasks");
    const shotFile = await (async () => {
      const fs = await import("node:fs");
      for (const entry of fs.readdirSync(tasksDir, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(
          tasksDir,
          entry.name,
          "screenshots",
          "call-e2e-shot.png"
        );
        if (existsSync(candidate)) return candidate;
      }
      return null;
    })();
    assert(
      shotFile !== null,
      `截图未落盘到 ${tasksDir}/*/screenshots/call-e2e-shot.png`
    );
    console.log(`[e2e] 截图已落盘：${shotFile}`);

    // 4) 最终回复可见；第三轮请求体里工具结果以文本回填（默认降级：无 image_url）
    await window
      .getByTestId("message-assistant")
      .getByText("浏览器工具链路 OK")
      .waitFor({ timeout: 30_000 });
    assert(receivedBodies.length >= 3, "模型请求数不足三轮");
    const third = receivedBodies[2];
    assert(
      third.includes("browser_screenshot"),
      "第三轮请求未回填截图工具结果"
    );
    assert(
      third.includes("image_url") === false,
      "默认（未开附图开关）不应包含 image_url"
    );
    console.log("[e2e] 工具结果以文本回填模型（降级路径）；最终回复可见");

    await closeApp(app);
    console.log("[e2e] 浏览器工具 E2E 通过 ✅");
  } catch (error) {
    console.error("[e2e] 浏览器工具 E2E 失败 ❌", error);
    process.exitCode = 1;
    try {
      await closeApp(app);
    } catch {
      // 已关闭
    }
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
}

await main();
