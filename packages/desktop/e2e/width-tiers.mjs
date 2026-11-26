// E2E 容器分档宽度（票 05，spec「宽度与布局」用户故事 31–35）：
// 内容列以任务容器（中栏，而非浏览器视口）为断点三档分宽，
// 头部 / 消息流共用同一内容列；输入卡片以正文列基准左右各外扩
// 12px（2026-11-19 呈现对齐轮定案，比正文列宽一点），
// 用户消息限宽右对齐，宽表格与代码块横向滚动内聚在自身容器。
// 场景：
// 1) 新建、已有与加载中使用同一三档内容列；草稿场景的就地收纳行（票01）
//    与消息流对齐，正式任务无页内工作区行（路径在标题栏徽章内）。
// 2) 窗口内容区 1280px（任务容器 960px ≥864）→ 5xl 档：
//    assistant 内容宽突破旧 768px 锁死值（2026-11-22 上限自 max-w-4xl 上移
//    一档至 max-w-5xl；此宽度下留白生效、上限不 bind，档位由计算样式断言钉住）。
// 3) 窗口内容区 1616px（容器 1296px ≥1280，留 16px 断点余量）→ 7xl 档：内容列留白 192px，上限 1280px
//    （2026-11-22 自 max-w-6xl/1152px 上移一档；此宽度下上限不 bind，计算样式断言钉住）；
//    头部 / 消息流左右缘对齐，输入卡片左右各外扩 12px；用户气泡右对齐内容列右缘。
// 4) 宽表格与长代码行在自身容器内横向滚动，消息流滚动容器无横向溢出。
// 5) 窗口内容区 1060px（容器 740px <864）→ 基础档：内容列回落全宽（<1024px）；
//    票04 窗口底线（1000）之上留出夹紧/取整余量，窄档基线不再压 minWidth 线。
// 5b) 窗口内容区 1520px（容器 1200px，5xl 档）→ max-w-5xl 上限几何生效：
//    留白后可用宽 1072px−滚动槽 > 1024px，内容列钉在 1024px
//    （调宽前钉在 896px，此腿是上限上移的直接几何证据）。
// 6) ADR 0018 右栏重基线：检视右栏为常驻分栏（推窄消息流，非 overlay），
//    默认宽 400px（窄容器自动夹取，正文最小宽 480 保底），分隔条可拖拽；
//    标题栏「右栏开关」唯一开合入口，tab 互斥切换由右栏自带描边按钮承担。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  assert,
  closeApp,
  closeRailPanel,
  launchApp,
  openRailPanel,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

/** 档位换算依据：侧栏固定 w-80（320px），窗口内容区宽 - 320 = 任务容器宽 */
const SIDEBAR_WIDTH = 320;
const STREAM_PADDING = 32; // 消息流滚动容器 px-4 × 2
/** 桌面双卡（A）外壳附加的横向留白：页根 p-1(8px) + 左栏 gap-2(8px) +
 *  中列卡描边(2px)——内容列比无壳布局窄 18px。 */
const SHELL_INSET = 18;
/** 输入卡左右各比正文列外扩的宽度（-mx-3，2026-11-19 呈现对齐轮定案） */
const COMPOSER_BREAKOUT = 12;

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

/** 档位断言（计算样式）：内容列当前生效的 max-width（浏览器解析为 px 值）。
 *  上限只在更宽窗口才几何生效（本机 7xl 生效点窗口 ≥1824px 摆不下），
 *  用 computed maxWidth 钉住「档位类已切换」，与几何断言互补。 */
async function assertActiveMaxWidth(window, expectedPx, label) {
  const maxWidth = await window
    .getByTestId("message-list")
    .evaluate((el) => getComputedStyle(el).maxWidth);
  assert(
    maxWidth === `${expectedPx}px`,
    `${label}：内容列生效上限应为 ${expectedPx}px，实际 ${maxWidth}`
  );
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
      titlebar: rect('[data-testid="workspace-topbar"]'),
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
  // 票01：任务头行与 workspace-info 行取消；草稿场景的就地收纳行仍须与
  // 消息列对齐。正式任务的路径收进标题栏徽章，无此行。
  if ((await window.getByTestId("workspace-path").count()) > 0) {
    const box = await window.getByTestId("workspace-path").boundingBox();
    assert(box !== null, `${label}：workspace-path 必须可见`);
    assert(
      Math.abs(box.x - content.x) <= 1 &&
        Math.abs(box.width - content.width) <= 1,
      `${label}：workspace-path 与消息列左右缘一致，实际 ${JSON.stringify({ box, content })}`
    );
  }
  const composer = await window.getByTestId("composer-card").boundingBox();
  assert(composer !== null, `${label}：输入卡片必须可见`);
  // 输入卡左右各比消息列外扩 12px（2026-11-19 起取代「同宽」口径）
  assert(
    Math.abs(composer.x - (content.x - COMPOSER_BREAKOUT)) <= 1 &&
      Math.abs(
        composer.x +
          composer.width -
          (content.x + content.width + COMPOSER_BREAKOUT)
      ) <= 1,
    `${label}：输入卡片应比消息列左右各宽 ${COMPOSER_BREAKOUT}px，实际 ${JSON.stringify({ composer, content })}`
  );
  return content;
}

/**
 * 新建任务居中起点列（票01，ADR 0026 变体 A）：草稿态主列整体替换为居中
 * 起点页——列容器 max-w-[800px]（含两侧 px-6 共 48px 内边距）、任务容器
 * 内容区内水平居中、工作区卡与专属输入卡（new-task-composer）同宽；容器
 * 不足 848px 时列回落全宽。期望宽运行时按 root.clientWidth（不含竖滚动
 * 条占位）自算：min(clientWidth, 800) − 48，滚动条有无都自适应。
 */
const NEW_TASK_COLUMN_PADDING = 48; // 居中列 px-6 × 2

async function assertNewTaskStart(window, label) {
  await assertViewportLayout(window, label);
  const geometry = await window.evaluate(() => {
    const root = document.querySelector('[data-testid="new-task-start"]');
    const composer = document.querySelector(
      '[data-testid="new-task-composer"]'
    );
    const info = document.querySelector('[data-testid="draft-workspace-info"]');
    if (!root || !composer) return null;
    const rootRect = root.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    return {
      // 期望宽以滚动条内侧内容区为基准（clientWidth 不含竖滚动条占位）
      expectedWidth: Math.min(root.clientWidth, 800) - 48,
      composerWidth: composerRect.width,
      insetStart: composerRect.left - rootRect.left,
      insetEnd: rootRect.left + root.clientWidth - composerRect.right,
      infoAligned:
        info === null
          ? null
          : Math.abs(info.getBoundingClientRect().left - composerRect.left) <=
              1 &&
            Math.abs(info.getBoundingClientRect().width - composerRect.width) <=
              1,
    };
  });
  assert(geometry !== null, `${label}：新建居中列必须可见`);
  assert(
    Math.abs(geometry.composerWidth - geometry.expectedWidth) <= 2,
    `${label}：新建居中列宽应为 ${geometry.expectedWidth}（±2 取整容差）：实测 ${geometry.composerWidth}`
  );
  assert(
    Math.abs(geometry.insetStart - geometry.insetEnd) <= 1,
    `${label}：新建居中列应在任务容器内水平居中：左留白 ${geometry.insetStart}，右留白 ${geometry.insetEnd}`
  );
  if (geometry.infoAligned !== null) {
    assert(
      geometry.infoAligned,
      `${label}：工作区卡与输入卡在居中列内左右缘一致`
    );
  }
  return geometry;
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

    // 准备：设置页创建 Profile（baseURL 指向本地 mock）→ 新建任务
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    await assertViewportLayout(window, "设置页");
    const profileForm = window.locator("form");
    await profileForm.getByLabel("名称").fill("Mock");
    await profileForm.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel("API Key").fill("sk-e2e");
    await profileForm.getByLabel("模型 1").fill("mock-model");
    await window
      .locator("form")
      .getByRole("button", { name: /保存|创建/ })
      .click();
    await window.getByText("Mock").first().waitFor();
    await window.getByTestId("settings-back").click();
    await prepareDraft(window);

    // 固定窗口内容区 1280×800：任务容器 = 1280 - 320 = 960px
    await resizeWindow(app, 1280, 800);

    // 场景 1（票01 居中起点页）：新建任务为 800px 居中列（ADR 0026 变体 A
    // 定稿），不再复用任务态内容列分档——工作区卡与输入卡同宽、列水平居中。
    await assertNewTaskStart(window, "新建任务");
    await window.screenshot({ path: join(screenshots, "new-task.png") });

    // 发送消息 → mock 返回宽表格 + 长代码行
    await window.getByTestId("composer-input").fill("来一个大宽表格");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("message-assistant").waitFor();
    await waitForReplyDone(window);
    // 滚动槽基线在任务态消息流上测（草稿态居中页无消息流）
    const emptyGutter = await window
      .getByTestId("message-stream")
      .evaluate((el) => el.offsetWidth - el.clientWidth);

    // 场景 2：5xl 档（容器 960px）：突破 768px 旧锁死；此宽度下留白生效、
    // max-w-5xl 上限不 bind，档位切换由计算样式断言钉住（2026-11-22 上移前为 896px）
    const tier5xl = await assertContentWidth(window, {
      min: 769,
      max: 1024,
      label: "5xl 档（容器 960px）",
    });
    await assertActiveMaxWidth(window, 1024, "5xl 档（容器 960px）");
    assert(
      tier5xl.width > 768,
      `5xl 档 assistant 内容宽 ${tier5xl.width} 必须突破旧 768px 锁死值`
    );

    // 场景 3：7xl 档（窗口内容区 1616 → 容器 1296px ≥1280）：留白 192px，上限 1280px。
    // 窗口不取 1600：容器恰压 1280 断点线零余量，DPI 夹紧/取整掉档会让
    // expectedWide±2 假红（2026-11-22 注释换算修正轮顺手抬 16px 余量）。
    // 此宽度下上限同样不 bind，档位切换由计算样式断言钉住（上移前为 1152px）。
    await resizeWindow(app, 1616, 900);
    const wideGutter = await window
      .getByTestId("message-stream")
      .evaluate((el) => el.offsetWidth - el.clientWidth);
    const expectedWide = Math.min(
      1616 - SHELL_INSET - SIDEBAR_WIDTH - STREAM_PADDING - wideGutter - 192,
      1280
    );
    const tier7xl = await assertContentWidth(window, {
      min: expectedWide - 2,
      max: expectedWide + 2,
      label: "7xl 档（容器 1280px）",
    });
    await assertActiveMaxWidth(window, 1280, "7xl 档（容器 1280px）");
    assert(
      tier7xl.width > tier5xl.width,
      `容器放宽后内容列应变宽：${tier7xl.width} > ${tier5xl.width}`
    );

    // 头部与消息列对齐，输入卡片左右各外扩 12px。
    await assertAligned(window, "message-list", "7xl 档");

    // 用户气泡限宽右对齐：右缘与 assistant 内容列右缘对齐
    const userBox = await window.getByTestId("message-user").boundingBox();
    assert(userBox !== null, "用户消息必须可见");
    assert(
      userBox.width < tier7xl.width,
      `用户气泡应限宽（${userBox.width} < 内容列 ${tier7xl.width}）`
    );
    assert(
      Math.abs(userBox.x + userBox.width - (tier7xl.x + tier7xl.width)) <= 2,
      `用户气泡应右对齐内容列右缘：气泡右缘 ${userBox.x + userBox.width}，内容列右缘 ${
        tier7xl.x + tier7xl.width
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

    // 场景 5：基础档（窗口内容区 1060 → 容器 740px <864）：内容列回落全宽。
    // 票04 窗口底线：窄档基线从 1000 提到 1060——1000 压 minWidth 线，
    // 夹紧 + DPI 取整会让 content 实际宽出 1~2px，精确档位断言不再成立。
    await resizeWindow(app, 1060, 800);
    const gutter = await window
      .getByTestId("message-stream")
      .evaluate((el) => el.offsetWidth - el.clientWidth);
    const expectedFull =
      1060 - SHELL_INSET - SIDEBAR_WIDTH - STREAM_PADDING - gutter;
    const tierBase = await assertContentWidth(window, {
      min: expectedFull - 2,
      max: 1023,
      label: "基础档（容器 740px）",
    });
    assert(
      tierBase.width < tier5xl.width,
      `容器收窄后内容列应变窄：${tierBase.width} < ${tier5xl.width}`
    );

    await assertAligned(window, "message-list", "基础档已有任务");

    // 场景 5b：5xl 上限几何生效（窗口内容区 1520 → 容器 1200px，5xl 档）：
    // 留白后可用宽 1200−32−96−滚动槽 ≈ 1057px > 1024px，内容列钉在上限
    // 1024px（2026-11-22 上移前钉在 896px，此腿是上限上移的直接几何证据）。
    await resizeWindow(app, 1520, 900);
    const tier5xlBound = await assertContentWidth(window, {
      min: 1022,
      max: 1026,
      label: "5xl 上限几何生效（容器 1200px）",
    });
    assert(
      tier5xlBound.width > tierBase.width,
      `容器放宽后内容列应超过基础档：${tier5xlBound.width} > ${tierBase.width}`
    );

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
    assert(scrolling.overflowing, "真实长任务应产生纵向滚动");
    assert(scrolling.gutter === emptyGutter, "出现滚动条不能改变稳定槽宽度");
    const afterScroll = await assertAligned(window, "message-list", "滚动后");
    assert(
      Math.abs(beforeScroll.x - afterScroll.x) <= 1 &&
        Math.abs(beforeScroll.width - afterScroll.width) <= 1,
      "出现纵向滚动时内容列不能跳宽"
    );
    await window.screenshot({
      path: join(screenshots, "existing-task.png"),
    });

    // ADR 0018 右栏重基线：面板改为常驻分栏——打开把消息流推窄（并列
    // 而非覆盖），内容列在收窄后的消息流内重新计算；外层 @container/task
    // 分档不因右栏开合而降档（容器宽不变）。右栏默认宽 400px。
    await resizeWindow(app, 1600, 900);
    const closed = await assertAligned(window, "message-list", "右栏关闭");
    for (const tab of ["resources", "changes"]) {
      await openRailPanel(window, tab);
      const opened = await assertAligned(window, "message-list", `右栏 ${tab}`);
      // 推窄（非覆盖）：内容列显著窄于关闭态
      assert(
        opened.width < closed.width - 100,
        `${tab} 右栏打开应推窄消息流（并列而非覆盖）`
      );
      // 右栏默认宽 400（1600 视口远超上限，不触发窄容器夹取）
      const railBox = await window.getByTestId("rail-panel").boundingBox();
      assert(
        Math.abs(railBox.width - 400) <= 2,
        `${tab} 右栏默认宽应为 400：${railBox.width}`
      );
      // 并列在消息流右侧：不与消息流水平重叠
      const stream = await window.getByTestId("message-stream").boundingBox();
      assert(
        railBox.x >= stream.x + stream.width - 1,
        `${tab} 右栏应并列在消息流右侧而非覆盖`
      );
      await window.screenshot({ path: join(screenshots, `rail-${tab}.png`) });
      await closeRailPanel(window);
      const restored = await assertAligned(
        window,
        "message-list",
        `${tab} 收起`
      );
      assert(
        Math.abs(restored.width - closed.width) <= 1,
        "收起右栏恢复原内容宽度"
      );
    }

    // 默认与窄窗口下右栏 tab 互斥切换：右栏宽受容器夹取（默认 400 与
    // 「行宽 − 正文最小宽 480」取小），消息流保底不低于正文最小宽；
    // 标题栏控件仍可见、不越出窗口。
    for (const width of [1280, 1060]) {
      await resizeWindow(app, width, 800);
      await openRailPanel(window, "resources");
      // 切 tab：右栏自带描边按钮互斥切换
      await window.getByTestId("rail-tab-changes").click();
      await window.getByTestId("changes-panel").waitFor();
      assert(
        (await window.getByTestId("rail-panel").count()) === 1,
        "右栏单实例，切 tab 不产生第二个面板容器"
      );
      assert(
        (await window.getByTestId("resources-panel").count()) === 0,
        "切到改动 tab 后规范面板不再挂载"
      );
      assert(
        (await window
          .getByTestId("resources-toggle")
          .getAttribute("aria-expanded")) === "true" &&
          (await window
            .getByTestId("rail-tab-changes")
            .getAttribute("aria-selected")) === "true",
        "标题栏开关与右栏 tab 状态同步"
      );
      const content = await assertAligned(
        window,
        "message-list",
        `${width} 右栏`
      );
      assert(content.width > 0, `${width} 右栏打开时内容列仍可用`);
      const title = await window.getByTestId("task-title").boundingBox();
      assert(
        title.width >= 40,
        `${width} 右栏打开时标题不能被压成零宽：${title.width}`
      );
      const viewportWidth = await window.evaluate(() => window.innerWidth);
      for (const testId of ["workspace-opener-main", "resources-toggle"]) {
        const button = await window.getByTestId(testId).boundingBox();
        assert(
          button !== null &&
            button.x >= 0 &&
            button.x + button.width <= viewportWidth,
          `${width} 右栏打开 ${testId} 应在标题栏内可见且不越出窗口：${JSON.stringify({ button, viewportWidth })}`
        );
      }
      // 右栏宽度约束：默认 400 与打开时容器上限（行宽 − 480）取小；
      // 窄窗口（1060，票04 底线之上）命中夹取而非默认宽。
      // 行 = rail-panel 的祖父节点（RailPanel 根 div 的父级：主列+右栏行）。
      const railSize = await window
        .getByTestId("rail-panel")
        .evaluate((el) => ({
          width: el.getBoundingClientRect().width,
          rowWidth:
            el.parentElement.parentElement.getBoundingClientRect().width,
        }));
      const expectedRail = Math.min(400, railSize.rowWidth - 480);
      assert(
        Math.abs(railSize.width - expectedRail) <= 2,
        `${width} 右栏宽 ${railSize.width} 应为 min(400, 行宽−480)（${expectedRail}）`
      );
      // 消息流保底：推窄后仍不低于正文最小宽（分隔条 6px 余量）
      const streamBox = await window
        .getByTestId("message-stream")
        .boundingBox();
      assert(
        streamBox.width >= 470,
        `${width} 右栏打开时消息流不得低于正文最小宽 480（实际 ${streamBox.width}）`
      );
      // 改动面板在右栏边界内且可用
      const railBox = await window.getByTestId("rail-panel").boundingBox();
      const panel = await window.getByTestId("changes-panel").boundingBox();
      assert(
        panel.height > 100 &&
          panel.x >= railBox.x - 1 &&
          panel.x + panel.width <= railBox.x + railBox.width + 1,
        `${width} 改动面板应在右栏边界内且可用`
      );
      // 桌面双卡（A）：窄右栏下 tab 行横向滚动（被遮挡 tab 由行首下拉菜单
      // 直达），tab 按钮会被滚动容器裁切——边界断言只覆盖非滚动控件
      // （行首菜单、刷新、提交等），排除 role="tab" 的滚动按钮。
      for (const button of await window
        .getByTestId("rail-panel")
        .locator("button:not([role='tab'])")
        .all()) {
        const box = await button.boundingBox();
        assert(
          box.x >= railBox.x &&
            box.x + box.width <= railBox.x + railBox.width + 1,
          `${width} 右栏内操作按钮仍在右栏边界内`
        );
      }
      await window.screenshot({
        path: join(screenshots, `rail-${width}.png`),
      });
      await window.getByTestId("theme-toggle").click();
      await assertAligned(window, "message-list", `${width} 右栏切换主题`);
      await window.getByTestId("theme-toggle").click();
      // 标题栏「右栏开关」再次点击关闭整个右栏。
      await closeRailPanel(window);
    }

    // 同一真实任务通过IPC应答闸门切回：只延迟真实结果，不伪造历史。
    const task = window.getByTestId("task-item").first();
    for (const [width, height] of [
      [1060, 800],
      [1280, 800],
      [1600, 900],
    ]) {
      await resizeWindow(app, width, height);
      const existing = await assertAligned(
        window,
        "message-list",
        `${width} 已有`
      );
      await window.getByTestId("new-task").click();
      await window.getByTestId("draft-select-workspace").waitFor();
      // 票01 起新建为居中起点列：不与任务内容列断同宽（两套布局并存），
      // 只断言列宽随容器回落/保持 800 上限与水平居中。
      await assertNewTaskStart(window, `${width} 新建`);
      await app.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get("tasks:view");
        ipcMain.removeHandler("tasks:view");
        ipcMain.handle("tasks:view", async (event, ...args) => {
          ipcMain.removeHandler("tasks:view");
          ipcMain.handle("tasks:view", original);
          const result = await original(event, ...args);
          await new Promise((resolve) => {
            globalThis.widthViewRelease = resolve;
          });
          return result;
        });
      });
      await task.click();
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
            throw new Error("tasks:view 加载闸门在5秒内未就绪");
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
