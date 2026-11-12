// 票 06 集成验收视觉走查（playwright-core + 生产产物 + mock provider）：
// 构造含交错轮次（思考/正文/工具卡/连续同类/失败卡/中断轮）的长会话，
// 覆盖 浅/深主题 × 宽/窄窗口 × 空态/长会话 截图矩阵，重点：
// 轮次分组与已工作折叠区收起/展开、「回到最新」按钮、宽度分档、
// 中断轮强制展开；并在同一会话内做 滚动跟随+思考恢复+折叠区+宽度
// 四组行为组合核查（DOM 断言记录 walkthrough-combo.log）。
// 运行：node .scratch/message-stream/acceptance/walkthrough.mjs（先 pnpm build）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const OUT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const helpers = await import(
  pathToFileURL(join(ROOT, "packages/desktop/e2e/helpers.mjs")).href
);
const {
  assert,
  closeApp,
  launchApp,
  prepareDraft,
  startMockProvider,
  expandWorkedHistory,
} = helpers;

const comboLog = [];
function combo(line) {
  comboLog.push(line);
  console.log(`[combo] ${line}`);
}

const FINAL_TEXT = [
  "调研完成：note.txt 与 note2.txt 都读过了，missing.txt 不存在（失败卡为预期样本）。",
  "",
  "| 文件 | 状态 | 说明 |",
  "| --- | --- | --- |",
  "| note.txt | 成功 | 第一个文件内容 |",
  "| note2.txt | 成功 | 第二个文件内容 |",
  "| missing.txt | 失败 | 目标不存在（组头「含失败」样本） |",
  "",
  "宽度分档说明：内容列按会话容器分档，本行用于观察宽屏下正文列宽度。",
  "",
  "```ts",
  "const widthTiers = { empty: 672, mid: 896, wide: 1152 }; // 容器分档上限（px）",
  "```",
].join("\n");

async function resizeWindow(app, width, height) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]);
    },
    [width, height]
  );
  await delay(250);
}

/** 消息流滚动几何 + 末段 assistant 内容宽度 */
async function geometry(window) {
  return window.evaluate(() => {
    const el = document.querySelector('[data-testid="message-stream"]');
    if (el === null) return null;
    const last = [
      ...el.querySelectorAll('[data-testid="assistant-content"]'),
    ].at(-1);
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      distance: el.scrollHeight - el.clientHeight - el.scrollTop,
      lastAssistantWidth: last?.getBoundingClientRect().width ?? 0,
      hasHorizontalOverflow: el.scrollWidth > el.clientWidth,
    };
  });
}

async function setScrollTop(window, value) {
  await window.evaluate((top) => {
    document.querySelector('[data-testid="message-stream"]').scrollTop = top;
  }, value);
  await delay(150);
}

/** 轮询直到滚动几何满足谓词（与 e2e scroll-following 的 until 同口径） */
async function untilGeom(window, predicate, message, timeout = 10_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const state = await geometry(window);
    if (state !== null && predicate(state)) return state;
    if (Date.now() >= end)
      assert(false, `${message}（最后状态：${JSON.stringify(state)}）`);
    await delay(60);
  }
}

/** 用户上翻脱离跟随（wheel 可重试，等脱离完成） */
async function wheelUpDetach(window, stream) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await stream.hover();
    await window.mouse.wheel(0, -1600);
    try {
      return await untilGeom(
        window,
        (s) => s.distance > 150,
        "用户上翻应脱离跟随",
        2_000
      );
    } catch {
      // 重试下一轮 wheel
    }
  }
  return untilGeom(
    window,
    (s) => s.distance > 150,
    "用户上翻应脱离跟随",
    1_000
  );
}

/** 等发送按钮解除禁用（冷启动时 profiles/会话加载完成前 send 是 disabled） */
async function waitSendEnabled(window, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await window.getByTestId("composer-send").isEnabled()) return;
    await delay(100);
  }
  assert(false, "发送按钮应在冷启动就绪后可用");
}

async function shot(window, name) {
  await window.screenshot({ path: join(OUT_DIR, `${name}.png`) });
  console.log(`[shot] ${name}.png`);
}

async function expandAllHistories(window) {
  const total = await window.getByTestId("worked-history-toggle").count();
  for (let i = 0; i < total; i++) {
    await expandWorkedHistory(window, i);
  }
  return total;
}

/** 收起全部已工作折叠区（开合为渲染层记忆态，截图矩阵需要显式复位） */
async function collapseAllHistories(window) {
  const toggles = window.getByTestId("worked-history-toggle");
  const total = await toggles.count();
  for (let i = 0; i < total; i++) {
    const toggle = toggles.nth(i);
    if ((await toggle.getAttribute("aria-expanded")) === "true") {
      await toggle.click();
      await delay(150);
    }
  }
}

async function main() {
  const model = await startMockProvider((ctx, { body }) => {
    if (body.includes("CodexLike 的子代理")) {
      ctx.textRound("子代理报告（走查不涉及）");
      return;
    }
    const data = JSON.parse(body);
    const text = data.messages.filter((m) => m.role === "user").at(-1)?.content;
    if (text === "调研这些文件") {
      if (body.includes('"walk-3"')) {
        ctx.send({
          delta: { reasoning_content: "读完了，汇总两份文件并出结论" },
          finish_reason: null,
        });
        ctx.textRound(FINAL_TEXT);
      } else if (body.includes('"walk-2"')) {
        ctx.toolCallRound("walk-3", "read_file", { path: "missing.txt" });
      } else if (body.includes('"walk-1"')) {
        ctx.toolCallRound("walk-2", "read_file", { path: "note2.txt" });
      } else {
        ctx.send({
          delta: { reasoning_content: "先规划：逐个读文件再下结论" },
          finish_reason: null,
        });
        ctx.send({ delta: { content: "先读文件，" }, finish_reason: null });
        ctx.toolCallRound("walk-1", "read_file", { path: "note.txt" });
      }
      return;
    }
    if (text === "写一篇长文") {
      ctx.send({
        delta: { reasoning_content: "开始写长文（本轮将被中断）" },
        finish_reason: null,
      });
      ctx.textChunksRound(
        Array.from({ length: 24 }, (_, i) => `第${i}段长文内容。`),
        250
      );
      return;
    }
    ctx.textRound("收到");
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-walkthrough-"));
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);
  writeFileSync(join(workspaceDir, "note.txt"), "第一个文件内容");
  writeFileSync(join(workspaceDir, "note2.txt"), "第二个文件内容");

  let app;
  let window;
  try {
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    // 主题确定性归位：Electron userData 的 localStorage 主题镜像不随 homeDir
    // 隔离（e2e theme.mjs 同法处理残留），还原「未配置默认浅色」首启，
    // 保证截图文件名中的 light/dark 与实际主题一致。
    await window.evaluate(() =>
      localStorage.setItem("codexlike.theme", "light")
    );
    // Profile 先建再 reload：渲染端 profiles 只在挂载 effect 读取一次，
    // 挂载后经 preload API 创建的 profile 不会进入列表（send 恒禁用的竞态），
    // reload 让挂载 effect 重读，此刻 profile 已落库。
    await window.evaluate(async (port) => {
      await window.codexlike.providerProfiles.create({
        name: "Walkthrough Mock",
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: "sk-e2e",
        model: "walk-model",
      });
    }, model.port);
    await window.reload();
    await delay(600);
    assert(
      (await window.evaluate(() => document.documentElement.dataset.theme)) ===
        "light",
      "走查起始主题应为浅色"
    );
    await resizeWindow(app, 1600, 900);

    // Profile 已在 reload 前建好（见上），此处只建长会话草稿
    await prepareDraft(window, { approvalMode: "assist" });

    // ---- 构造长会话：轮1 工具交错（完成收起）/ 轮2 中断 / 轮3 宽内容 ----
    await window.getByTestId("composer-input").fill("调研这些文件");
    await waitSendEnabled(window);
    await window.getByTestId("composer-send").click();
    for (let i = 0; i < 150 && model.requestCount() < 4; i++) {
      await delay(100);
    }
    await window
      .getByTestId("message-assistant")
      .getByText("调研完成")
      .waitFor({ timeout: 20_000 });
    await delay(400);

    await window.getByTestId("composer-input").fill("写一篇长文");
    await waitSendEnabled(window);
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .getByText("第0段长文内容")
      .waitFor({ timeout: 20_000 });
    await window.getByTestId("composer-stop").click();
    await window
      .getByText("（已中断，以上为部分回复）")
      .waitFor({ timeout: 10_000 });
    await delay(400);

    await window.getByTestId("composer-input").fill("总结一下");
    await waitSendEnabled(window);
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .getByText("宽度分档说明")
      .waitFor({ timeout: 20_000 });
    await delay(400);
    assert(
      (await window.getByTestId("message-turn").count()) === 3,
      "长会话应有 3 个轮次分组"
    );

    // ---- 截图矩阵：长会话 × 主题 × 宽度 ----
    // 主题态流转：01-02 浅 → 03-04 深 → 05 浅 → 06 深 → 07-08 浅 → 09 深 → 组合段浅
    await setScrollTop(window, 0);
    await shot(window, "01-light-wide-long-collapsed");

    await expandAllHistories(window);
    await setScrollTop(window, 0);
    await shot(window, "02-light-wide-long-expanded");

    await window.getByTestId("theme-toggle").click();
    await delay(200);
    await collapseAllHistories(window);
    await setScrollTop(window, 0);
    await shot(window, "03-dark-wide-long-collapsed");
    await expandAllHistories(window);
    await setScrollTop(window, 0);
    await shot(window, "04-dark-wide-long-expanded");

    await resizeWindow(app, 1000, 800);
    await window.getByTestId("theme-toggle").click();
    await delay(200);
    await collapseAllHistories(window);
    await setScrollTop(window, 0);
    await shot(window, "05-light-narrow-long-collapsed");
    await window.getByTestId("theme-toggle").click();
    await delay(200);
    await setScrollTop(window, 0);
    await shot(window, "06-dark-narrow-long-collapsed");
    await window.getByTestId("theme-toggle").click();
    await delay(200);

    // ---- 中断轮强制展开（切回浅色、宽窗口，滚动到中断轮）----
    await resizeWindow(app, 1600, 900);
    await expandAllHistories(window);
    const interruptedToggle = window
      .getByTestId("worked-history-toggle")
      .nth(1);
    await interruptedToggle.scrollIntoViewIfNeeded();
    await delay(150);
    assert(
      (await interruptedToggle.getAttribute("aria-expanded")) === "true",
      "中断轮折叠区应强制展开"
    );
    await shot(window, "07-light-wide-interrupted-turn");

    // ---- 回到最新按钮（窄 + 宽 各一张）----
    await resizeWindow(app, 1000, 800);
    const stream = window.getByTestId("message-stream");
    await wheelUpDetach(window, stream);
    await window.getByTestId("back-to-latest").waitFor();
    await shot(window, "08-light-narrow-back-to-latest");
    await resizeWindow(app, 1600, 900);
    await window.getByTestId("theme-toggle").click();
    await delay(200);
    await shot(window, "09-dark-wide-back-to-latest");
    await window.getByTestId("back-to-latest").click();
    await delay(400);
    await window.getByTestId("theme-toggle").click();
    await delay(200);

    // ---- 组合行为核查（同一长会话：跟随+思考恢复+折叠区+宽度）----
    combo(
      `组合核查会话：3 轮（轮1 工具交错+宽表格/代码、轮2 中断、轮3 纯正文短回复）`
    );
    // a. 窄档宽度基准
    await resizeWindow(app, 1000, 800);
    let g = await geometry(window);
    combo(
      `a. 窄窗口(1000)基础档：末段正文宽 ${g.lastAssistantWidth.toFixed(1)}px（应 <800，容器-32 基准），滚动容器横向溢出=${g.hasHorizontalOverflow}`
    );
    assert(g.lastAssistantWidth < 800, "窄档末段正文宽度应 <800px");
    assert(!g.hasHorizontalOverflow, "滚动容器不应横向溢出");
    // b. 上翻脱离 + 回到最新可见
    g = await wheelUpDetach(window, stream);
    assert(
      (await window.getByTestId("back-to-latest").count()) === 1,
      "组合 b：回到最新应可见"
    );
    combo(
      `b. 上翻脱离：scrollTop=${g.scrollTop.toFixed(0)} 距底=${g.distance.toFixed(0)}px，back-to-latest 可见`
    );
    const detachedTop = g.scrollTop;
    // c. 脱离态下展开全部折叠区：阅读位置不被夺走
    await expandAllHistories(window);
    await delay(300);
    g = await geometry(window);
    assert(
      Math.abs(g.scrollTop - detachedTop) < 4,
      `组合 c：展开折叠区不得夺滚动权（${detachedTop} → ${g.scrollTop}）`
    );
    assert(
      (await window.getByTestId("back-to-latest").count()) === 1,
      "组合 c：展开后应仍处脱离态"
    );
    const thinkingCount = await window.getByTestId("thinking-block").count();
    combo(
      `c. 脱离态展开 ${await window
        .getByTestId("worked-history-toggle")
        .count()} 个折叠区：scrollTop 保持 ${g.scrollTop.toFixed(0)}（Δ<4px），思考块 ${thinkingCount} 个可见可展开，仍脱离`
    );
    await setScrollTop(window, detachedTop);
    // d. 脱离态下放宽窗口：档位上移、仍脱离
    await resizeWindow(app, 1600, 900);
    g = await geometry(window);
    assert(g.lastAssistantWidth > 896, "组合 d：宽档末段正文应 >896px");
    assert(
      (await window.getByTestId("back-to-latest").count()) === 1,
      "组合 d：宽度切换后应仍处脱离态"
    );
    combo(
      `d. 放宽(1600)：末段正文宽 ${g.lastAssistantWidth.toFixed(1)}px（档位上移），仍脱离（back-to-latest 在）`
    );
    const leaveTop = g.scrollTop;
    await shot(window, "14-combo-wide-detached-expanded");
    // e. 切走再切回：像素恢复 + 思考完整 + 手动展开态保持
    await window.getByTestId("new-session").click();
    await window.getByTestId("message-empty").waitFor();
    await window.getByTestId("draft-select-workspace").click();
    await window
      .getByTestId("session-item")
      .filter({ hasText: "调研这些文件" })
      .click();
    await window
      .getByTestId("message-assistant")
      .getByText("宽度分档说明")
      .waitFor({ timeout: 20_000 });
    await delay(300);
    g = await geometry(window);
    assert(
      Math.abs(g.scrollTop - leaveTop) < 4,
      `组合 e：切回应恢复像素阅读位置（${leaveTop} → ${g.scrollTop}）`
    );
    const firstExpanded = await window
      .getByTestId("worked-history-toggle")
      .first()
      .getAttribute("aria-expanded");
    assert(firstExpanded === "true", "组合 e：手动展开态应跨切换保持");
    combo(
      `e. 切走再切回：scrollTop ${leaveTop.toFixed(0)} → ${g.scrollTop.toFixed(0)}（Δ<4px），折叠区手动展开态保持（aria-expanded=${firstExpanded}），思考恢复不丢`
    );
    await shot(window, "15-combo-restored-position");
    // f. 回到最新：恢复跟随
    await window.getByTestId("back-to-latest").click();
    for (let i = 0; i < 40; i++) {
      g = await geometry(window);
      if (g.distance <= 48) break;
      await delay(100);
    }
    assert(g.distance <= 48, "组合 f：回到最新应贴底");
    assert(
      (await window.getByTestId("back-to-latest").count()) === 0,
      "组合 f：恢复跟随后按钮应消失"
    );
    combo(
      `f. 回到最新：距底 ${g.distance.toFixed(1)}px（≤48 贴底），跟随恢复按钮消失`
    );

    // ---- 空态矩阵（新草稿会话）----
    await prepareDraft(window);
    await window.getByTestId("message-empty").waitFor();
    await shot(window, "10-light-wide-empty");
    await window.getByTestId("theme-toggle").click();
    await delay(200);
    await shot(window, "11-dark-wide-empty");
    await resizeWindow(app, 1000, 800);
    await shot(window, "12-dark-narrow-empty");
    await window.getByTestId("theme-toggle").click();
    await delay(200);
    await shot(window, "13-light-narrow-empty");

    await closeApp(app);
    app = null;
    console.log("[walkthrough] 视觉走查与组合核查全部通过 ✅");
  } catch (error) {
    console.error("[walkthrough] 失败 ❌", error);
    process.exitCode = 1;
    try {
      await closeApp(app);
    } catch {
      // 已关闭
    }
  } finally {
    writeFileSync(
      join(OUT_DIR, "logs", "walkthrough-combo.log"),
      comboLog.join("\n") + "\n",
      "utf8"
    );
    model.server.close();
    model.server.closeAllConnections();
    rmSync(homeDir, { recursive: true, force: true });
  }
}

await main();
