// E2E 容器分档宽度（票 05，spec「宽度与布局」用户故事 31–35）：
// 内容列以会话容器（中栏，而非浏览器视口）为断点三档分宽，
// 头部 / 消息流共用同一内容列，输入卡片左右各外扩 8px，
// 用户消息限宽右对齐，宽表格与代码块横向滚动内聚在自身容器。
// 场景：
// 1) 新建、已有与加载中使用同一三档内容列，工作区信息也与消息流对齐。
// 2) 窗口内容区 1280px（会话容器 992px ≥864）→ 4xl 档：
//    assistant 内容宽突破旧 768px 锁死值且 ≤896px（max-w-4xl 上限）。
// 3) 窗口内容区 1600px（容器 1312px ≥1280）→ 6xl 档：内容列留白 192px，上限 1152px；
//    头部 / 消息流左右缘对齐，输入卡片外扩；用户气泡右对齐内容列右缘。
// 4) 宽表格与长代码行在自身容器内横向滚动，消息流滚动容器无横向溢出。
// 5) 窗口内容区 1000px（容器 712px <864）→ 基础档：内容列回落全宽（<896px）。
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

/** 档位换算依据：侧栏固定 w-72（288px），窗口内容区宽 - 288 = 会话容器宽 */
const SIDEBAR_WIDTH = 288;
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

/** 文档不承担滚动，消息区和输入区始终留在窗口内容区内。 */
async function assertViewportLayout(window, label) {
  const layout = await window.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const { top, bottom, height } = element.getBoundingClientRect();
      return { top, bottom, height };
    };
    const root = document.scrollingElement;
    return {
      viewportHeight: innerHeight,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      titlebar: rect('[data-testid="window-titlebar"]'),
      stream: rect('[data-testid="message-stream"]'),
      composer: rect('[data-testid="composer-card"]'),
    };
  });
  const details = `${label}：${JSON.stringify(layout)}`;
  assert(
    layout.scrollHeight <= layout.clientHeight + 1 &&
      layout.scrollWidth <= layout.clientWidth + 1,
    `根文档不应产生额外滚动条，${details}`
  );
  if (layout.stream && layout.composer) {
    assert(layout.stream.height > 0, `消息区不能被压扁，${details}`);
    assert(
      layout.stream.top >= layout.titlebar.bottom - 1 &&
        layout.stream.bottom <= layout.composer.top + 1 &&
        layout.composer.bottom <= layout.viewportHeight + 1,
      `消息区和输入区应在标题栏下方且不重叠、不越出视口，${details}`
    );
  }
}

/** 从真实渲染几何验证内容列，不依赖组件树或宽度类实现。 */
async function assertAligned(window, contentTestId, label) {
  await assertViewportLayout(window, label);
  const content = await window.getByTestId(contentTestId).boundingBox();
  assert(content !== null, `${label}：内容列必须可见`);
  for (const testId of ["session-header-content", "workspace-path"]) {
    const box = await window.getByTestId(testId).boundingBox();
    assert(box !== null, `${label}：${testId} 必须可见`);
    assert(
      Math.abs(box.x - content.x) <= 1 &&
        Math.abs(box.width - content.width) <= 1,
      `${label}：${testId} 与消息列左右缘一致，实际 ${JSON.stringify({ box, content })}`
    );
  }
  const composer = await window.getByTestId("composer-card").boundingBox();
  assert(composer !== null, `${label}：输入卡片必须可见`);
  assert(
    Math.abs(content.x - composer.x - 8) <= 1 &&
      Math.abs(composer.x + composer.width - content.x - content.width - 8) <=
        1,
    `${label}：输入卡片应比消息列左右各宽 8px，实际 ${JSON.stringify({ composer, content })}`
  );
  return content;
}

async function main() {
  const { server, port } = await startMockProvider((ctx) => {
    ctx.textRound(WIDE_REPLY);
  });
  const screenshots = mkdtempSync(
    join(tmpdir(), "codexlike-width-screenshots-")
  );
  console.log(`[e2e:width] 布局截图目录 ${screenshots}`);
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-width-"));
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);

  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    const window = first.window;
    await window.getByTestId("settings-open").waitFor();
    await assertViewportLayout(window, "冷启动");

    // 准备：设置页创建 Profile（baseURL 指向本地 mock）→ 新建会话
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    await assertViewportLayout(window, "设置页");
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
    await window.getByTestId("settings-back").click();
    await prepareDraft(window);

    // 固定窗口内容区 1280×800：会话容器 = 1280 - 288 = 992px
    await resizeWindow(app, 1280, 800);

    // 场景 1：新建草稿与已有会话采用相同 4xl 档，不再单独收窄。
    const emptyBox = await window.getByTestId("message-empty").boundingBox();
    assert(emptyBox !== null, "空态提示必须可见");
    assert(
      emptyBox.width > 768 && emptyBox.width <= 896,
      `新建草稿应采用 4xl 内容列（>768 且 ≤896）：实测 ${emptyBox.width}`
    );
    await assertAligned(window, "message-empty", "新建会话");
    const emptyGutter = await window
      .getByTestId("message-stream")
      .evaluate((el) => el.offsetWidth - el.clientWidth);
    await window.screenshot({ path: join(screenshots, "new-session.png") });

    // 发送消息 → mock 返回宽表格 + 长代码行
    await window.getByTestId("composer-input").fill("来一个大宽表格");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").waitFor();
    await waitForReplyDone(window);

    // 场景 2：4xl 档（容器 992px）：突破 768px 旧锁死，上限 896px
    const tier4 = await assertContentWidth(window, {
      min: 769,
      max: 896,
      label: "4xl 档（容器 992px）",
    });
    assert(
      tier4.width > 768,
      `4xl 档 assistant 内容宽 ${tier4.width} 必须突破旧 768px 锁死值`
    );

    // 场景 3：6xl 档（窗口内容区 1600 → 容器 1312px ≥1280）：留白 192px，上限 1152px
    await resizeWindow(app, 1600, 900);
    const wideGutter = await window
      .getByTestId("message-stream")
      .evaluate((el) => el.offsetWidth - el.clientWidth);
    const expectedWide = Math.min(
      1600 - SIDEBAR_WIDTH - STREAM_PADDING - wideGutter - 192,
      1152
    );
    const tier6 = await assertContentWidth(window, {
      min: expectedWide - 2,
      max: expectedWide + 2,
      label: "6xl 档（容器 1312px）",
    });
    assert(
      tier6.width > tier4.width,
      `容器放宽后内容列应变宽：${tier6.width} > ${tier4.width}`
    );

    // 头部与消息列对齐，输入卡片左右各外扩 8px。
    await assertAligned(window, "message-list", "6xl 档");

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

    // 场景 5：基础档（窗口内容区 1000 → 容器 712px <864）：内容列回落全宽
    await resizeWindow(app, 1000, 800);
    const gutter = await window
      .getByTestId("message-stream")
      .evaluate((el) => el.offsetWidth - el.clientWidth);
    const expectedFull = 1000 - SIDEBAR_WIDTH - STREAM_PADDING - gutter;
    const tierBase = await assertContentWidth(window, {
      min: expectedFull - 2,
      max: 895,
      label: "基础档（容器 712px）",
    });
    assert(
      tierBase.width < tier4.width,
      `容器收窄后内容列应变窄：${tierBase.width} < ${tier4.width}`
    );

    await assertAligned(window, "message-list", "基础档已有会话");

    // 两轮回复在低窗口内溢出：复制反馈的 sr-only 元素不得越过消息流撑大文档。
    // 真实内容溢出时滚动槽仍保持原宽度，输入区和标题不横跳。
    await resizeWindow(app, 1280, 600);
    const beforeScroll = await assertAligned(window, "message-list", "滚动前");
    const input = window.getByTestId("composer-input");
    await input.fill("再来一个大宽表格");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").nth(1).waitFor();
    await waitForReplyDone(window);
    const scrolling = await window
      .getByTestId("message-stream")
      .evaluate((el) => ({
        gutter: el.offsetWidth - el.clientWidth,
        overflowing: el.scrollHeight > el.clientHeight,
      }));
    assert(scrolling.overflowing, "真实长会话应产生纵向滚动");
    assert(scrolling.gutter === emptyGutter, "出现滚动条不能改变稳定槽宽度");
    const afterScroll = await assertAligned(window, "message-list", "滚动后");
    assert(
      Math.abs(beforeScroll.x - afterScroll.x) <= 1 &&
        Math.abs(beforeScroll.width - afterScroll.width) <= 1,
      "出现纵向滚动时内容列不能跳宽"
    );
    await window.screenshot({
      path: join(screenshots, "existing-session.png"),
    });

    // 独立面板是整个主列的兄弟，外层分档不因面板打开而降档。
    await resizeWindow(app, 1600, 900);
    const closed = await assertAligned(window, "message-list", "面板关闭");
    const headerHeight = (
      await window.getByTestId("session-header-content").boundingBox()
    ).height;
    for (const [toggle, panel] of [
      ["resources-toggle", "resources-panel"],
      ["changes-toggle", "changes-panel"],
    ]) {
      await window.getByTestId(toggle).click();
      await window.getByTestId(panel).waitFor();
      const opened = await assertAligned(window, "message-list", panel);
      assert(opened.width < closed.width, `${panel} 应占据主列旁边空间`);
      const panelBox = await window.getByTestId(panel).boundingBox();
      assert(opened.x + opened.width <= panelBox.x, `${panel} 不能覆盖主列`);
      const header = await window
        .getByTestId("session-header-content")
        .boundingBox();
      assert(
        Math.abs(header.height - headerHeight) <= 1,
        "面板打开后标题操作行不能换行变高"
      );
      // 外层仍为 >=1280 档；若错误改用收窄后主列分档，实际宽度会多 96px。
      const streamWidth = await window
        .getByTestId("message-stream")
        .evaluate((el) => el.clientWidth);
      assert(
        Math.abs(opened.width - (streamWidth - STREAM_PADDING - 192)) <= 1,
        "面板打开仍使用外层会话容器的6xl档留白"
      );
      await window.screenshot({ path: join(screenshots, `${panel}.png`) });
      await window.getByTestId(toggle).click();
      const restored = await assertAligned(
        window,
        "message-list",
        `${panel} 收起`
      );
      assert(
        Math.abs(restored.width - closed.width) <= 1,
        "收起面板恢复原内容宽度"
      );
    }

    // 默认与窄窗口同时打开两个面板，标题仍可见、操作不侵入面板。
    for (const width of [1280, 1000]) {
      await resizeWindow(app, width, 800);
      await window.getByTestId("resources-toggle").click();
      await window.getByTestId("changes-toggle").click();
      await window.getByTestId("resources-panel").waitFor();
      await window.getByTestId("changes-panel").waitFor();
      const content = await assertAligned(
        window,
        "message-list",
        `${width} 双面板`
      );
      const title = await window.getByTestId("session-title").boundingBox();
      assert(
        title.width >= 40,
        `${width} 双面板标题不能被压成零宽：${title.width}`
      );
      for (const testId of [
        "session-search-toggle",
        "resources-toggle",
        "changes-toggle",
      ]) {
        const button = await window.getByTestId(testId).boundingBox();
        assert(
          button.x >= content.x - 1 &&
            button.x + button.width <= content.x + content.width + 1,
          `${width} 双面板 ${testId} 不得溢出主列：${JSON.stringify({ button, content })}`
        );
      }
      for (const testId of ["resources-panel", "changes-panel"]) {
        const panel = await window.getByTestId(testId).boundingBox();
        assert(
          panel.height > 100 && panel.x >= content.x + content.width,
          `${width} 双面板均应可用且不覆盖主列`
        );
        const panelHeader = window
          .getByTestId(testId)
          .locator("header")
          .first();
        for (const button of await panelHeader.locator("button").all()) {
          const box = await button.boundingBox();
          assert(
            box.x >= panel.x && box.x + box.width <= panel.x + panel.width + 1,
            `${width} ${testId} 内部操作仍在面板边界内`
          );
        }
      }
      await window.screenshot({
        path: join(screenshots, `both-panels-${width}.png`),
      });
      await window.getByTestId("theme-toggle").click();
      await assertAligned(window, "message-list", `${width} 双面板切换主题`);
      await window.getByTestId("theme-toggle").click();
      await window.getByTestId("changes-close").click();
      await window.getByTestId("changes-panel").waitFor({ state: "hidden" });
      await window.getByTestId("resources-toggle").click();
      await window.getByTestId("resources-panel").waitFor({ state: "hidden" });
    }

    // 同一真实会话通过IPC应答闸门切回：只延迟真实结果，不伪造历史。
    const session = window.getByTestId("session-item").first();
    for (const [width, height, min, max] of [
      [1000, 800, expectedFull - 2, expectedFull + 2],
      [1280, 800, 769, 896],
      [1600, 900, expectedWide - 2, expectedWide + 2],
    ]) {
      await resizeWindow(app, width, height);
      const existing = await assertAligned(
        window,
        "message-list",
        `${width} 已有`
      );
      await window.getByTestId("new-session").click();
      await window.getByTestId("draft-select-workspace").waitFor();
      const draft = await assertAligned(
        window,
        "message-empty",
        `${width} 新建`
      );
      assert(
        draft.width >= min && draft.width <= max,
        `${width} 新建使用相应档位`
      );
      assert(Math.abs(existing.width - draft.width) <= 1, "已有转新建不跳宽");
      await app.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get("sessions:view");
        ipcMain.removeHandler("sessions:view");
        ipcMain.handle("sessions:view", async (event, ...args) => {
          ipcMain.removeHandler("sessions:view");
          ipcMain.handle("sessions:view", original);
          const result = await original(event, ...args);
          await new Promise((resolve) => {
            globalThis.widthViewRelease = resolve;
          });
          return result;
        });
      });
      await session.click();
      await window
        .getByTestId("draft-select-workspace")
        .waitFor({ state: "hidden" });
      await window.waitForFunction(
        () =>
          document.querySelector('[data-testid="composer-input"]')?.readOnly ===
          true
      );
      const loading = await assertAligned(
        window,
        "message-empty",
        `${width} 加载中`
      );
      assert(Math.abs(existing.width - loading.width) <= 1, "切换加载中不跳宽");
      await app.evaluate(async () => {
        const deadline = Date.now() + 5000;
        while (!globalThis.widthViewRelease) {
          if (Date.now() >= deadline)
            throw new Error("sessions:view 加载闸门在5秒内未就绪");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        globalThis.widthViewRelease();
        delete globalThis.widthViewRelease;
      });
      await window.getByTestId("message-list").waitFor();
      const restored = await assertAligned(
        window,
        "message-list",
        `${width} 加载完成`
      );
      assert(Math.abs(existing.width - restored.width) <= 1, "加载完成不跳宽");
    }

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
