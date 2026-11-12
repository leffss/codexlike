// E2E 容器分档宽度（票 05，spec「宽度与布局」用户故事 31–35）：
// 内容列以会话容器（中栏，而非浏览器视口）为断点三档分宽，
// 头部 / 消息流 / 输入区共用同一内容列左右缘对齐，
// 用户消息限宽右对齐，宽表格与代码块横向滚动内聚在自身容器。
// 场景：
// 1) 空态（新建草稿未发送）：内容列 2xl（≤672px），消息流与输入区对齐。
// 2) 窗口内容区 1280px（会话容器 1024px ≥864）→ 4xl 档：
//    assistant 内容宽突破旧 768px 锁死值且 ≤896px（max-w-4xl 上限）。
// 3) 窗口内容区 1600px（容器 1344px ≥1280）→ 6xl 档：内容列 1152px；
//    头部 / 消息流 / 输入区三处左右缘对齐；用户气泡右对齐内容列右缘。
// 4) 宽表格与长代码行在自身容器内横向滚动，消息流滚动容器无横向溢出。
// 5) 窗口内容区 1000px（容器 744px <864）→ 基础档：内容列回落全宽（<896px）。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  assert,
  closeApp,
  launchApp,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

/** 档位换算依据：侧栏固定 w-64（256px），窗口内容区宽 - 256 = 会话容器宽 */
const SIDEBAR_WIDTH = 256;
const STREAM_PADDING = 32; // 消息流滚动容器 px-4 × 2

/** 宽内容回复：12 列宽表格 + 220 字符长代码行，在任何档位都超出内容列宽。
 *  表格数据用不可断 token（长无空格字符串）撑宽——可折行文本（如中文）
 *  会在单元格内换行、表格收缩到容器宽，触发不了横向滚动。 */
const COLUMNS = 12;
const WIDE_CELL = "X".repeat(30);
const WIDE_REPLY = [
  "宽内容演示：",
  "",
  `| ${Array.from({ length: COLUMNS }, (_, i) => `表头列${i + 1}`).join(" | ")} |`,
  `| ${Array.from({ length: COLUMNS }, () => "---").join(" | ")} |`,
  `| ${Array.from({ length: COLUMNS }, () => WIDE_CELL).join(" | ")} |`,
  "",
  "```ts",
  `const longLine = "${Array.from({ length: 220 }, () => "x").join("")}";`,
  "```",
].join("\n");

/** 调整窗口内容区尺寸（CSS 像素与 Electron DIP 一致），并等一帧布局稳定 */
async function resizeWindow(app, width, height) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]);
    },
    [width, height]
  );
  await delay(200);
}

async function waitForReplyDone(window) {
  // streaming 期间发送按钮禁用；恢复可用即本轮回复完成
  const send = window.getByTestId("composer-send");
  await send.waitFor();
  for (let i = 0; i < 100; i += 1) {
    if (await send.isEnabled()) return;
    await delay(100);
  }
  assert(false, "等待回复完成超时");
}

/** contentWidth 档位断言：assistant 消息实际渲染宽度落在 [min, max] 区间 */
async function assertContentWidth(window, { min, max, label }) {
  const box = await window.getByTestId("message-assistant").boundingBox();
  assert(box !== null, `${label}：message-assistant 必须可见`);
  assert(
    box.width >= min && box.width <= max,
    `${label}：assistant 内容宽 ${box.width} 应在 [${min}, ${max}]`
  );
  return box;
}

async function main() {
  const { server, port } = await startMockProvider((ctx) => {
    ctx.textRound(WIDE_REPLY);
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-width-"));
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);

  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    const window = first.window;

    // 准备：设置页创建 Profile（baseURL 指向本地 mock）→ 新建会话
    await window.getByRole("button", { name: "设置", exact: true }).click();
    await window.getByTestId("profile-create").click();
    const profileForm = window.locator("form");
    await profileForm.getByLabel("名称").fill("Mock");
    await profileForm.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel("API Key").fill("sk-e2e");
    await profileForm.getByLabel("模型").fill("mock-model");
    await window
      .locator("form")
      .getByRole("button", { name: /保存|创建/ })
      .click();
    await window.getByText("Mock").first().waitFor();
    await window.getByRole("button", { name: "返回工作台" }).click();
    await prepareDraft(window);

    // 固定窗口内容区 1280×800：会话容器 = 1280 - 256 = 1024px
    await resizeWindow(app, 1280, 800);

    // 场景 1：空态内容列 2xl（672px），消息流空态与输入区卡片同宽对齐
    const emptyBox = await window.getByTestId("message-empty").boundingBox();
    assert(emptyBox !== null, "空态提示必须可见");
    assert(
      emptyBox.width <= 673,
      `空态内容列应 ≤672（2xl）：实测 ${emptyBox.width}`
    );
    const composerCard = await window
      .getByTestId("composer-card")
      .boundingBox();
    assert(composerCard !== null, "输入区卡片必须可见");
    assert(
      Math.abs(composerCard.width - emptyBox.width) <= 1,
      `空态下消息流与输入区应共用 2xl 内容列：${composerCard.width} vs ${emptyBox.width}`
    );

    // 发送消息 → mock 返回宽表格 + 长代码行
    await window.getByTestId("composer-input").fill("来一个大宽表格");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").waitFor();
    await waitForReplyDone(window);

    // 场景 2：4xl 档（容器 1024px）：突破 768px 旧锁死，上限 896px
    const tier4 = await assertContentWidth(window, {
      min: 769,
      max: 896,
      label: "4xl 档（容器 1024px）",
    });
    assert(
      tier4.width > 768,
      `4xl 档 assistant 内容宽 ${tier4.width} 必须突破旧 768px 锁死值`
    );

    // 场景 3：6xl 档（窗口内容区 1600 → 容器 1344px ≥1280）：上限 1152px
    await resizeWindow(app, 1600, 900);
    const tier6 = await assertContentWidth(window, {
      min: 1100,
      max: 1153,
      label: "6xl 档（容器 1344px）",
    });
    assert(
      tier6.width > tier4.width,
      `容器放宽后内容列应变宽：${tier6.width} > ${tier4.width}`
    );

    // 三处共用同一内容列：头部内容 / 消息列表 / 输入卡片左右缘对齐
    const headerBox = await window
      .getByTestId("session-header-content")
      .boundingBox();
    const listBox = await window.getByTestId("message-list").boundingBox();
    const composerBox = await window.getByTestId("composer-card").boundingBox();
    for (const [name, box] of [
      ["头部内容", headerBox],
      ["消息列表", listBox],
      ["输入卡片", composerBox],
    ]) {
      assert(box !== null, `${name}必须可见`);
      assert(
        Math.abs(box.x - tier6.x) <= 1 &&
          Math.abs(box.width - tier6.width) <= 1,
        `${name}（x=${box.x}, w=${box.width}）应与消息列（x=${tier6.x}, w=${tier6.width}）左右缘对齐`
      );
    }

    // 用户气泡限宽右对齐：右缘与 assistant 内容列右缘对齐
    const userBox = await window.getByTestId("message-user").boundingBox();
    assert(userBox !== null, "用户消息必须可见");
    assert(
      userBox.width < tier6.width,
      `用户气泡应限宽（${userBox.width} < 内容列 ${tier6.width}）`
    );
    assert(
      Math.abs(userBox.x + userBox.width - (tier6.x + tier6.width)) <= 2,
      `用户气泡应右对齐内容列右缘：气泡右缘 ${userBox.x + userBox.width}，内容列右缘 ${
        tier6.x + tier6.width
      }`
    );

    // 场景 4：宽表格 / 代码块在自身容器内横向滚动，滚动容器无横向溢出
    const metrics = await window.evaluate(() => {
      const stream = document.querySelector('[data-testid="message-stream"]');
      const wrapper = document.querySelector(
        '[data-testid="assistant-content"] div.overflow-x-auto'
      );
      const pre = document.querySelector(
        '[data-testid="assistant-content"] pre'
      );
      const pick = (element) =>
        element && {
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      return {
        stream: pick(stream),
        tableWrapper: pick(wrapper),
        pre: pick(pre),
      };
    });
    assert(metrics.tableWrapper, "宽表格必须包进内聚滚动容器");
    assert(
      metrics.tableWrapper.scrollWidth > metrics.tableWrapper.clientWidth,
      `宽表格应在自身容器内横向滚动：scroll ${metrics.tableWrapper.scrollWidth} > client ${metrics.tableWrapper.clientWidth}`
    );
    assert(
      metrics.pre && metrics.pre.scrollWidth > metrics.pre.clientWidth,
      "长代码行应在 pre 自身容器内横向滚动"
    );
    assert(
      metrics.stream.scrollWidth <= metrics.stream.clientWidth + 1,
      `消息流滚动容器不应有横向溢出：scroll ${metrics.stream.scrollWidth} > client ${metrics.stream.clientWidth}`
    );

    // 场景 5：基础档（窗口内容区 1000 → 容器 744px <864）：内容列回落全宽
    await resizeWindow(app, 1000, 800);
    const expectedFull = 1000 - SIDEBAR_WIDTH - STREAM_PADDING; // 容器全宽 - 消息流水平 padding
    const tierBase = await assertContentWidth(window, {
      min: expectedFull - 2,
      max: 895,
      label: "基础档（容器 744px）",
    });
    assert(
      tierBase.width < tier4.width,
      `容器收窄后内容列应变窄：${tierBase.width} < ${tier4.width}`
    );

    console.log("width-tiers: 全部断言通过");
  } finally {
    await closeApp(app);
    rmSync(homeDir, { recursive: true, force: true });
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
