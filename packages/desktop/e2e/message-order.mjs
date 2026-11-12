// E2E 时序保真（消息流重构票 01，GLOSSARY「消息段」）：一轮
// 「思考 → 正文 → 工具调用 → 思考 → 正文」交错回复在 DOM 中按事件发生
// 顺序排列——思考段不再被提升到轮次顶部合并、工具调用之后产生的正文
// 显示在工具卡之后。断言方式为严格 testid 序列（不靠文本过滤），
// 并验证思考折叠块与工具卡在新结构下的折叠交互不变、重启恢复形状。
// 票 04 起过程段收进轮次「已工作折叠区」（收起时不渲染），时序断言
// 在展开折叠区后进行；收起默认与展开回看本身也是断言对象。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  assert,
  closeApp,
  expandWorkedHistory,
  launchApp,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

/**
 * 消息流段序列：每个列表项（li）自身的 testid，或其第一个带
 * testid 的子孙元素（thinking 块的 testid 在 details 上、li 是布局壳）。
 * 轮次分组（票 04）后嵌套轮内 ol 的 li 同样按 DOM 序收集。
 */
async function segmentOrder(window) {
  return window.evaluate(() => {
    const stream = document.querySelector('[data-testid="message-stream"]');
    if (stream === null) return null;
    return [...stream.querySelectorAll("ol > li")].map((li) => {
      if (li.hasAttribute("data-testid")) return li.dataset.testid;
      const inner = li.querySelector("[data-testid]");
      return inner === null ? null : inner.dataset.testid;
    });
  });
}

/** 在渲染进程按当前本地日历重算，重启不能沿用旧短标签。 */
async function assertCompletedTime(window, iso) {
  const actual = await window
    .getByTestId("assistant-completed-at")
    .evaluate((time) => {
      const completed = new Date(time.dateTime);
      const now = new Date();
      const parts = new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(completed);
      const part = (name) => parts.find((item) => item.type === name).value;
      const date = `${part("year")}-${part("month")}-${part("day")}`;
      const hm = `${part("hour")}:${part("minute")}`;
      const sameYear = completed.getFullYear() === now.getFullYear();
      const sameDay = completed.toDateString() === now.toDateString();
      return {
        iso: time.dateTime,
        label: time.textContent,
        title: time.title,
        expectedLabel: sameDay
          ? hm
          : `${sameYear ? date.slice(5) : date} ${hm}`,
        expectedTitle: `${date} ${hm}:${part("second")}`,
      };
    });
  assert(actual.iso === iso, "完成时间 ISO 必须保持终态消息原值");
  assert(
    actual.label === actual.expectedLabel,
    `短标签应按当前本地日期重算：${JSON.stringify(actual)}`
  );
  assert(actual.title === actual.expectedTitle, "title 应显示本地完整日期及秒");
}

async function assertCopyState(window, name) {
  const button = window.getByTestId("assistant-copy");
  assert(
    (await button.getAttribute("aria-label")) === name,
    `复制入口名称应为 ${name}`
  );
  assert(
    (await button.getAttribute("title")) === name,
    `复制入口 title 应为 ${name}`
  );
  assert((await button.textContent()) === "", "图标按钮不应残留可见文字");
  assert(
    (await button.locator('svg[aria-hidden="true"]').count()) === 1,
    "图标应从无障碍树隐藏"
  );
  assert(
    (await button.locator("svg rect").count()) === (name === "已复制" ? 0 : 1),
    "成功显示勾，其他状态显示复制图标"
  );
}

async function main() {
  const finalMarkdown =
    "**结论：内容正确**\n\n保留 Markdown\n\n```ts\nconst ok = true;\n```";
  let finishFinal;
  const { server, port, seenBodies } = await startMockProvider(
    (ctx, { index }) => {
      if (index === 1) {
        // 第 1 轮：思考 → 正文（半段）→ read_file 工具调用（真实执行）
        ctx.send({
          delta: { reasoning_content: "先思考怎么读" },
          finish_reason: null,
        });
        ctx.send({ delta: { content: "先读文件，" }, finish_reason: null });
        ctx.toolCallRound("order-c1", "read_file", { path: "note.txt" });
        return;
      }
      if (index === 2) {
        // 第 2 轮（工具回填后）：再思考 → 最终正文
        ctx.send({
          delta: { reasoning_content: "再核对一遍" },
          finish_reason: null,
        });
        ctx.send({ delta: { content: finalMarkdown }, finish_reason: null });
        // 显式门控终态，保证测试可观察流式正文与终态时间的分界。
        finishFinal = () => ctx.finishWith("stop");
        return;
      }
      ctx.textRound("收到");
    }
  );
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-order-"));
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);
  writeFileSync(join(workspaceDir, "note.txt"), "时序 e2e 预置内容");

  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    let window = first.window;

    // 准备：设置页创建 Profile（baseURL 指向本地 mock）→ 新建会话
    await window.getByTestId("settings-open").click();
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
    await window.getByTestId("settings-back").click();
    await prepareDraft(window);

    // 从公开事件接口记录终态消息，不通过数据库或 UI 当前时间反推。
    await window.evaluate(() => {
      window.messageCompletion = null;
      window.removeCompletionListener = window.codexlike.onSessionEvent(
        ({ event }) => {
          if (event.type === "assistant-done")
            window.messageCompletion = event.message;
        }
      );
    });

    // 发送消息：模型按「思考 → 正文 → 工具 → 思考 → 正文」交错输出
    await window.getByTestId("composer-input").fill("读一下 note.txt");
    await window.getByTestId("composer-send").click();
    for (let tick = 0; tick < 100 && seenBodies.length < 2; tick++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(seenBodies.length === 2, `预期 2 个请求，实际 ${seenBodies.length}`);
    await window
      .getByTestId("message-assistant")
      .getByText("结论：内容正确")
      .waitFor({ timeout: 20_000 });
    assert(
      (await window.getByTestId("assistant-actions").count()) === 0,
      "整轮流式期间不应显示任何正文操作栏"
    );
    assert(typeof finishFinal === "function", "最终回复应已到达终态门控");
    finishFinal();
    await window
      .getByTestId("assistant-completed-at")
      .waitFor({ timeout: 10_000 });
    const completedAt = await window
      .getByTestId("assistant-completed-at")
      .getAttribute("datetime");
    await assertCompletedTime(window, completedAt);
    const terminalMessage = await window.evaluate(() => {
      window.removeCompletionListener();
      return window.messageCompletion;
    });
    assert(
      completedAt === terminalMessage?.createdAt,
      "完成时间必须来自 assistant-done 的终态消息"
    );
    await assertCopyState(window, "复制");

    // 真实系统剪贴板读回：当前段原始 Markdown，不含过程正文和界面文案。
    await window.clock.install();
    await window.clock.pauseAt(new Date(Date.now() + 1000));
    await app.evaluate(({ clipboard }) => clipboard.writeText("复制前哨兵"));
    await window.getByTestId("assistant-copy").click();
    await window
      .getByTestId("assistant-copy-feedback")
      .filter({ hasText: "已复制" })
      .waitFor({ state: "attached" });
    await assertCopyState(window, "已复制");
    assert(
      (await window
        .getByTestId("assistant-copy-feedback")
        .getAttribute("class")) === "sr-only",
      "成功状态只向屏幕阅读器播报"
    );
    const firstCopied = await app.evaluate(({ clipboard }) =>
      clipboard.readText()
    );
    // 使用渲染器时钟精确验证两秒边界，避免额外真实等待。
    await window.clock.runFor(1999);
    await assertCopyState(window, "已复制");
    await window.clock.runFor(1);
    await assertCopyState(window, "复制");
    assert(
      (await window.getByTestId("assistant-copy-feedback").textContent()) ===
        "",
      "复位后成功反馈清空"
    );

    // 在成功计时仍未结束时再次复制；后续失败不应被旧成功定时器清空。
    await window.getByTestId("assistant-copy").click();
    await window
      .getByTestId("assistant-copy-feedback")
      .filter({ hasText: "已复制" })
      .waitFor({ state: "attached" });

    // 仅替换外部 Clipboard 边界模拟一次拒绝，重试恢复真实系统写入。
    await window.evaluate(() => {
      const clipboard = navigator.clipboard;
      const original = clipboard.writeText.bind(clipboard);
      clipboard.writeText = () => {
        clipboard.writeText = original;
        return Promise.reject(
          new DOMException("测试拒绝剪贴板", "NotAllowedError")
        );
      };
    });
    await window.getByTestId("assistant-copy").click();
    await window
      .getByTestId("assistant-copy-feedback")
      .filter({ hasText: "复制失败，请重试" })
      .waitFor();
    await assertCopyState(window, "重试复制");
    assert(
      await window.getByTestId("assistant-copy-feedback").isVisible(),
      "失败提示应保持可见"
    );
    await window.clock.runFor(2000);
    await assertCopyState(window, "重试复制");
    await app.evaluate(({ clipboard }) => clipboard.writeText("重试前哨兵"));
    await window.getByTestId("assistant-copy").click();
    await window
      .getByTestId("assistant-copy-feedback")
      .filter({ hasText: "已复制" })
      .waitFor({ state: "attached" });
    await assertCopyState(window, "已复制");
    const retriedCopied = await app.evaluate(({ clipboard }) =>
      clipboard.readText()
    );
    await window.clock.runFor(2000);
    await assertCopyState(window, "复制");
    await window.clock.resume();

    // 浅/深主题下的窄窗口布局与截图；独立临时目录保留给人工验收。
    const screenshots = mkdtempSync(
      join(tmpdir(), "codexlike-message-actions-screenshots-")
    );
    console.log(`[e2e:message-order] 消息操作栏截图目录 ${screenshots}`);
    const originalTheme = await window.evaluate(
      () => document.documentElement.dataset.theme
    );
    const originalViewport = await window.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    try {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(900, 720)
      );
      await window.waitForFunction(() => window.innerWidth === 900);
      for (const theme of ["light", "dark"]) {
        if (
          (await window.evaluate(
            () => document.documentElement.dataset.theme
          )) !== theme
        ) {
          await window.getByTestId("theme-toggle").click();
        }
        await window.waitForFunction(
          (expected) => document.documentElement.dataset.theme === expected,
          theme
        );
        await window.getByTestId("assistant-actions").scrollIntoViewIfNeeded();
        const layout = await window
          .getByTestId("assistant-actions")
          .evaluate((element) => {
            const actions = element.getBoundingClientRect();
            const copy = element
              .querySelector('[data-testid="assistant-copy"]')
              .getBoundingClientRect();
            const time = element.querySelector("time").getBoundingClientRect();
            const content = element.parentElement
              .querySelector('[data-testid="assistant-content"]')
              .getBoundingClientRect();
            const stream = element.closest('[data-testid="message-stream"]');
            const bounds = stream.getBoundingClientRect();
            const probe = document.createElement("span");
            probe.style.color = "var(--fg-muted)";
            element.append(probe);
            const themed =
              getComputedStyle(element).color === getComputedStyle(probe).color;
            probe.remove();
            return {
              themed,
              iconSize: copy.width === 28 && copy.height === 28,
              below: actions.top >= content.bottom,
              contained: [copy, time].every(
                (rect) =>
                  rect.width > 0 &&
                  rect.height > 0 &&
                  rect.left >= bounds.left &&
                  rect.right <= bounds.right &&
                  rect.top >= bounds.top &&
                  rect.bottom <= bounds.bottom
              ),
              separate:
                copy.right <= time.left ||
                time.right <= copy.left ||
                copy.bottom <= time.top ||
                time.bottom <= copy.top,
              noOverflow:
                stream.scrollWidth <= stream.clientWidth + 1 &&
                document.documentElement.scrollWidth <= window.innerWidth,
            };
          });
        assert(layout.themed, `${theme} 操作栏应使用主题弱化前景色`);
        assert(
          layout.iconSize &&
            layout.below &&
            layout.contained &&
            layout.separate &&
            layout.noOverflow,
          `${theme} 窄窗口操作栏应位于正文下方、完整可见、不重叠且无横向溢出：${JSON.stringify(layout)}`
        );
        await window.screenshot({
          path: join(screenshots, `message-actions-${theme}-narrow.png`),
        });
      }
    } finally {
      await app.evaluate(
        ({ BrowserWindow }, viewport) =>
          BrowserWindow.getAllWindows()[0].setContentSize(
            viewport.width,
            viewport.height
          ),
        originalViewport
      );
      if (
        (await window.evaluate(
          () => document.documentElement.dataset.theme
        )) !== originalTheme
      ) {
        await window.getByTestId("theme-toggle").click();
      }
      // Windows 125% 缩放下原生窗口往返取整可能偏差 1 CSS px（802 → 803）。
      await window.waitForFunction(
        ({ viewport, theme }) =>
          Math.abs(window.innerWidth - viewport.width) <= 1 &&
          Math.abs(window.innerHeight - viewport.height) <= 1 &&
          document.documentElement.dataset.theme === theme,
        { viewport: originalViewport, theme: originalTheme }
      );
    }

    // ---- 场景 1：轮完成后过程段收进已工作折叠区（票 04 默认收起）----
    let order = await segmentOrder(window);
    assert(Array.isArray(order), "消息流不存在");
    assert(
      JSON.stringify(order) ===
        JSON.stringify([
          "message-turn",
          "message-user",
          "worked-history",
          "message-assistant",
        ]),
      `轮完成后过程段应收进收起的已工作折叠区，只留最终正文：${JSON.stringify(order)}`
    );
    const collapsedToggle = window.getByTestId("worked-history-toggle");
    assert(
      (await collapsedToggle.getAttribute("aria-expanded")) === "false",
      "正常完成的轮折叠区应默认收起"
    );
    const summaryText = await window
      .getByTestId("worked-history-summary")
      .textContent();
    assert(
      summaryText !== null && summaryText.includes("已工作"),
      `折叠区摘要行应显示工时：${summaryText ?? "(空)"}`
    );
    // 展开回看完整过程
    await collapsedToggle.click();
    await window.getByTestId("worked-history-items").waitFor();

    assert(
      (await window.getByTestId("assistant-actions").count()) === 1,
      "展开过程区后仍仅最终正文显示操作栏"
    );

    // ---- 场景 1b：严格 DOM 时序断言（testid 序列，不靠文本过滤）----
    order = await segmentOrder(window);
    assert(
      JSON.stringify(order) ===
        JSON.stringify([
          "message-turn",
          "message-user",
          "worked-history",
          "thinking-block",
          "message-assistant",
          "tool-call-card",
          "thinking-block",
          "message-assistant",
        ]),
      `消息段顺序与事件发生顺序不一致：${JSON.stringify(order)}`
    );

    // 各段内容归属正确：两段思考独立成段、两段正文独立成段
    const thinkingTexts = await window.evaluate(() =>
      [...document.querySelectorAll('[data-testid="thinking-content"]')].map(
        (node) => node.textContent ?? ""
      )
    );
    assert(
      thinkingTexts.length === 2 &&
        thinkingTexts[0].includes("先思考怎么读") &&
        thinkingTexts[1].includes("再核对一遍"),
      `两段思考应交错独立存在：${JSON.stringify(thinkingTexts)}`
    );
    const assistantTexts = await window.evaluate(() =>
      [...document.querySelectorAll('[data-testid="assistant-content"]')].map(
        (node) => node.textContent ?? ""
      )
    );
    assert(
      assistantTexts.length === 2 &&
        assistantTexts[0].includes("先读文件，") &&
        !assistantTexts[0].includes("结论") &&
        assistantTexts[1].includes("结论：内容正确") &&
        !assistantTexts[1].includes("先读文件，"),
      `工具卡前后的两段正文应独立：${JSON.stringify(assistantTexts)}`
    );
    console.log("[e2e] 交错回复按事件发生顺序渲染（思考/正文/工具/思考/正文）");

    // ---- 场景 2：折叠交互在新结构下不变 ----
    const blocks = window.getByTestId("thinking-block");
    assert((await blocks.count()) === 2, "应有两个独立思考折叠块");
    const second = blocks.nth(1);
    const secondContent = second.getByTestId("thinking-content");
    assert(
      !(await secondContent.isVisible()),
      "思考块应默认收起（内容不可见）"
    );
    await second.getByTestId("thinking-toggle").click();
    await secondContent.waitFor({ timeout: 10_000 });
    assert(await secondContent.isVisible(), "展开后思考内容应可见");
    await second.getByTestId("thinking-toggle").click();
    assert(!(await secondContent.isVisible()), "收起后思考内容应不可见");

    const card = window.getByTestId("tool-call-card").first();
    assert(
      (await card.getAttribute("data-tool-name")) === "read_file",
      "工具卡应显示 read_file"
    );
    await card.getByTestId("tool-call-toggle").click();
    await card.getByText("时序 e2e 预置内容").waitFor({ timeout: 10_000 });
    console.log("[e2e] 思考折叠块与工具卡的折叠交互保持不变");

    // 异步复制尚未完成时离开会话；旧请求完成不得污染重新挂载的反馈。
    await window.evaluate(() => {
      const clipboard = navigator.clipboard;
      const original = clipboard.writeText.bind(clipboard);
      clipboard.writeText = () =>
        new Promise((resolve) => {
          window.finishPendingCopy = () => {
            clipboard.writeText = original;
            resolve();
          };
        });
    });
    await window.getByTestId("assistant-copy").click();
    await assertCopyState(window, "复制中");
    assert(
      await window.getByTestId("assistant-copy").isDisabled(),
      "复制进行中应禁止重复请求"
    );
    await window.getByTestId("new-session").click();
    await window
      .getByTestId("assistant-actions")
      .waitFor({ state: "detached" });
    await window.evaluate(() => window.finishPendingCopy());
    await window.getByTestId("session-item").first().click();
    await window.getByTestId("assistant-copy").waitFor();
    assert(
      (await window.getByTestId("assistant-copy-feedback").textContent()) ===
        "",
      "离开后重新打开不应继承旧复制反馈"
    );

    // ---- 场景 3：重启恢复后段形状（同一消息段序列）----
    await closeApp(app);
    const secondLaunch = await launchApp({ homeDir });
    app = secondLaunch.app;
    window = secondLaunch.window;
    await window
      .getByTestId("session-item")
      .first()
      .waitFor({ timeout: 15_000 });
    await window.getByTestId("session-item").first().click();
    await window
      .getByTestId("message-user")
      .first()
      .waitFor({ timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
    await window.getByTestId("assistant-completed-at").waitFor();
    assert(
      (await window
        .getByTestId("assistant-completed-at")
        .getAttribute("datetime")) === completedAt,
      "重启后的完成时间不得改成历史打开时刻"
    );
    await assertCompletedTime(window, completedAt);
    let restored = await segmentOrder(window);
    // 票 02 起落库历史带 reasoning；票 04 起恢复后正常完成的轮默认收起
    // 折叠区（过程段=工具卡与重建的思考段整体收进「已工作折叠区」）
    assert(
      JSON.stringify(restored) ===
        JSON.stringify([
          "message-turn",
          "message-user",
          "worked-history",
          "message-assistant",
        ]),
      `重启恢复后正常完成的轮应默认收起折叠区：${JSON.stringify(restored)}`
    );
    // 展开折叠区：工具卡 → 思考段（票 02 终态消息位置在工具卡之后）→ 终稿正文；
    // 运行期的多段思考拼接为终态全文
    await expandWorkedHistory(window, 0);
    await window.getByTestId("tool-call-card").waitFor({ timeout: 10_000 });
    restored = await segmentOrder(window);
    assert(
      JSON.stringify(restored) ===
        JSON.stringify([
          "message-turn",
          "message-user",
          "worked-history",
          "tool-call-card",
          "thinking-block",
          "message-assistant",
        ]),
      `重启恢复后展开折叠区的消息段序列不正确：${JSON.stringify(restored)}`
    );
    const restoredThinking = await window
      .getByTestId("thinking-block")
      .first()
      .getByTestId("thinking-content")
      .textContent();
    assert(
      restoredThinking !== null &&
        restoredThinking.includes("先思考怎么读") &&
        restoredThinking.includes("再核对一遍"),
      `恢复后的思考全文应包含两段：${restoredThinking ?? "(空)"}`
    );
    const restoredText = await window
      .getByTestId("message-assistant")
      .last()
      .getByTestId("assistant-content")
      .textContent();
    assert(
      restoredText !== null &&
        restoredText.includes("先读文件，") &&
        restoredText.includes("结论：内容正确"),
      `恢复后的终稿正文应完整：${restoredText ?? "(空)"}`
    );
    await window.getByTestId("assistant-copy").click();
    await window
      .getByTestId("assistant-copy-feedback")
      .filter({ hasText: "已复制" })
      .waitFor({ state: "attached" });
    const restoredCopied = await app.evaluate(({ clipboard }) =>
      clipboard.readText()
    );
    console.log(
      "[e2e] 主题截图、失败重试反馈、卸载隔离、重启消息段与完成时刻验证通过"
    );
    // 系统剪贴板断言最后汇总，环境异常也不阻断其余场景，但仍明确失败。
    assert(
      firstCopied === finalMarkdown &&
        retriedCopied === finalMarkdown &&
        restoredCopied === terminalMessage.content,
      `系统剪贴板必须保存当前段原始 Markdown：${JSON.stringify({ firstCopied, retriedCopied, restoredCopied, expectedFinal: finalMarkdown, expectedRestored: terminalMessage.content })}`
    );

    await closeApp(app);
    console.log("[e2e] 消息段时序保真场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 消息段时序保真场景失败 ❌", error);
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
