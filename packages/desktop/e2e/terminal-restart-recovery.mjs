// E2E（ADR 0033 票 09）：终端会话重启恢复 + 生命周期硬边。
// 路径：建任务 → 新建会话手敲命令 → 真实退出（quit #1：退出确认卡断言
// 「1 个终端会话将关闭。」提示行后取消，会话存活；quit #2：确认后进程正常
// 退出，屏障 flush 定格快照）→ 重启 →「已退出」组从库恢复（view.terminals
// → mergeTerminalRecords）→ 详情页快照回看（subscribe restoredSession，
// 快照作 buffered 回放）→ 归档确认卡路径（07 票断言面）：有存活会话时归档
// 先弹 archive-terminal-dialog，Escape/取消不发起归档 IPC、会话继续运行；
// 确认「归档并关闭会话」后宿主先杀等 exit 再写归档。
// 断言纪律同 terminal-sessions.mjs：xterm 文本层 + testid 清单 + 公开 IPC
// 只读识别（tasks.list / terminals.listFor），不读数据库、不碰组件内部状态。
// 重启恢复后零模型请求（08 票「重启不重放」语义对照）。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:terminal-restart（先 build）。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import {
  assert,
  closeApp,
  createMockProfile,
  launchApp,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";
import {
  focusTerminal,
  openTerminalRailTab,
  sendMessage,
  waitForIdle,
  xtermRowVisible,
} from "./terminal-helpers.mjs";

const TASK_TITLE = "终端重启恢复任务";
const REPLY_TEXT = "重启前任务就绪。";
// 输出值 3088 不出现在命令原文（terminal-sessions.mjs 头注释同款口径）
const COMMAND = "echo $((3000+88))";
const OUTPUT = "3088";

/** 等待轮询条件成立（归档/退出是异步 IPC + 宿主先杀等 exit，用确定轮询）。 */
async function until(predicate, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    assert(Date.now() < deadline, message);
    await delay(50);
  }
}

/** 等应用进程正常退出（exit-recovery.mjs 同款）。 */
function exited(app) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("应用进程未正常结束")),
      20000
    );
    app.process().once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function quit(app, window, confirm) {
  const done = exited(app);
  await app.evaluate(({ app: electronApp }) => {
    electronApp.quit();
  });
  if (confirm) await window.getByTestId("exit-confirm").click();
  const result = await done;
  assert(result.code === 0 && result.signal === null, "受控退出没有测试强杀");
}

async function taskRecord(window, taskId) {
  return window.evaluate(async (id) => {
    const records = await window.codexlike.tasks.list();
    return records.find((item) => item.id === id) ?? null;
  }, taskId);
}

async function taskSessions(window, taskId) {
  return window.evaluate(async (id) => {
    return window.codexlike.terminals.listFor(id);
  }, taskId);
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-e2e-terminal-restart-"));
  const homeDir = join(root, "home");
  const workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  const { server, port, requestCount } = await startMockProvider(
    async (ctx) => {
      ctx.textRound(REPLY_TEXT);
    }
  );

  let app;
  let window;
  let requestCountAfterRound = 0;
  try {
    const launched = await launchApp({ homeDir, workspaceDir });
    app = launched.app;
    window = launched.window;
    await createMockProfile(window, { name: "Mock", port });

    // ===== 链路 c 前半：建会话跑命令 =====
    await prepareDraft(window);
    await sendMessage(window, TASK_TITLE);
    await waitForIdle(window, REPLY_TEXT);
    requestCountAfterRound = 1;

    await openTerminalRailTab(window);
    await window.getByTestId("terminal-create").click();
    const item = window
      .getByTestId("terminal-rail-item")
      .filter({ hasText: "git-bash · 1" });
    await item.waitFor({ timeout: 15000 });
    await item.click();
    await window.getByTestId("terminal-rail-detail-header").waitFor();
    await focusTerminal(window);
    await window.keyboard.type(COMMAND);
    await window.keyboard.press("Enter");
    await xtermRowVisible(window, OUTPUT);
    // 回列表页再退出：后续断言走列表行状态（详情页无 rail-item）
    await window.getByTestId("terminal-rail-back").click();
    console.log("[e2e] 会话内命令输出可见，准备退出");

    const taskId = await window.evaluate(async (title) => {
      const records = await window.codexlike.tasks.list();
      const record = records.find((element) => element.title === title);
      return record ? record.id : null;
    }, TASK_TITLE);
    assert(taskId, "任务记录未找到");

    // ===== 链路 d 前半：退出屏障提示行（07 票断言面） =====
    // quit #1：确认卡出现且终端提示行 N=1 → 取消 → 会话仍在运行
    await app.evaluate(({ app: electronApp }) => {
      electronApp.quit();
    });
    const note = window.getByTestId("exit-terminal-note");
    await note.waitFor({ timeout: 10000 });
    assert(
      (await note.textContent()) === "1 个终端会话将关闭。",
      "退出确认卡应提示 1 个终端会话将关闭"
    );
    await window.getByTestId("exit-cancel").click();
    assert(
      (await window.getByTestId("exit-terminal-note").count()) === 0,
      "取消退出后确认卡应关闭"
    );
    await until(
      async () =>
        (await taskSessions(window, taskId)).every(
          (session) => session.status === "running"
        ),
      "取消退出后会话应继续运行"
    );
    await item.waitFor({ timeout: 10000 });
    assert(
      (await item.getAttribute("data-terminal-state")) === "running",
      "取消退出后列表行应保持 running"
    );
    console.log("[e2e] 退出屏障终端提示行（N=1）+ 取消后会话存活");

    // quit #2：确认退出 → 屏障 flush（killAll + 快照落库）→ 进程正常退出
    await quit(app, window, true);
    app = null;
    console.log("[e2e] 确认退出 → 快照 flush 落库 → 进程正常退出");

    // ===== 链路 c 后半：重启恢复 =====
    const relaunched = await launchApp({ homeDir, workspaceDir });
    app = relaunched.app;
    window = relaunched.window;
    await window
      .getByTestId("task-item")
      .filter({ hasText: TASK_TITLE })
      .waitFor({ timeout: 15000 });
    await window
      .getByTestId("task-item")
      .filter({ hasText: TASK_TITLE })
      .click();
    await window
      .getByTestId("message-user")
      .filter({ hasText: TASK_TITLE })
      .waitFor({ timeout: 10000 });

    // 「已退出」组从库恢复：重启后内存注册表空，view.terminals 并行字段
    // 下发已退出记录 → rail 列表恢复（08 票断言路径）
    await openTerminalRailTab(window);
    const restoredItem = window
      .getByTestId("terminal-rail-item")
      .filter({ hasText: "git-bash · 1" });
    await restoredItem.waitFor({ timeout: 15000 });
    const headers = window.getByTestId("terminal-rail-group-header");
    assert(
      (await headers.count()) === 1 &&
        (await headers.first().textContent()).includes("已退出"),
      "重启后应恢复为「已退出」分组"
    );
    assert(
      (await restoredItem.getAttribute("data-terminal-state")) === "exited",
      "恢复的列表行应为 exited"
    );

    // 详情页快照回看：subscribe restoredSession 查库行，快照作 buffered 回放
    await restoredItem.click();
    await window.getByTestId("terminal-rail-detail-header").waitFor();
    const restoredHeader = window.getByTestId("terminal-rail-detail-header");
    assert(
      (await restoredHeader.getByText("只读回看", { exact: true }).count()) ===
        1,
      "恢复的已退出会话详情页应为只读回看"
    );
    assert(
      (await window.getByTestId("terminal-rail-kill").count()) === 0,
      "恢复的已退出会话不应有终止按钮"
    );
    await xtermRowVisible(window, OUTPUT);
    console.log("[e2e] 重启后「已退出」组恢复 + 快照回看输出可见");

    // 重启不重放（08 票语义对照）：恢复与检视不触发任何模型请求；
    // 恢复记录全部为已退出（崩溃残留置终态之外的正常 flush 路径）
    assert(
      (await taskSessions(window, taskId)).every(
        (session) => session.status === "exited"
      ),
      "重启后恢复记录应全部为已退出"
    );

    // ===== 链路 d 后半：归档确认卡（07 票断言面） =====
    // 回列表页新建一个存活会话，归档该任务触发确认卡。注意：重启后进程内
    // name 计数器重置，新会话名与恢复行同为「git-bash · 1」（见票面遗留
    // 观察），故按 running 状态过滤定位而非会话名
    await window.getByTestId("terminal-rail-back").click();
    await window.getByTestId("terminal-create").click();
    const aliveItem = window.locator(
      '[data-testid="terminal-rail-item"][data-terminal-state="running"]'
    );
    await aliveItem.waitFor({ timeout: 15000 });
    assert(
      (await aliveItem.count()) === 1,
      "重启后应只有一个 running 会话（归档卡素材）"
    );

    const taskItem = window
      .getByTestId("task-item")
      .filter({ hasText: TASK_TITLE });
    const archiveDialog = async () => {
      await taskItem.click({ button: "right" });
      const menu = window.getByTestId("task-context-menu");
      await menu.waitFor();
      await menu.getByTestId("archive-button").click();
      const dialog = window.getByTestId("archive-terminal-dialog");
      await dialog.waitFor({ timeout: 10000 });
      return dialog;
    };

    // 卡片文案（07 票票面）：标题含任务名 + 正文 N 个会话仍在运行
    let dialog = await archiveDialog();
    const dialogText = await dialog.textContent();
    assert(
      dialogText.includes(TASK_TITLE) &&
        dialogText.includes("1 个终端会话仍在运行") &&
        dialogText.includes("归档并关闭会话"),
      `归档确认卡文案不完整：${dialogText}`
    );

    // 取消路径（Escape）：不发起归档 IPC——任务未归档、会话继续运行
    await window.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 5000 });
    await until(
      async () =>
        (await taskRecord(window, taskId))?.archivedAt === null &&
        (await taskSessions(window, taskId)).every(
          (session) => session.status === "running"
        ),
      "取消归档后任务未归档且会话存活"
    );
    console.log("[e2e] 归档确认卡取消路径：不归档、会话存活");

    // 确认路径：宿主先杀等 exit 再写归档——任务归档 + 会话推进 exited
    dialog = await archiveDialog();
    await dialog.getByTestId("archive-terminal-confirm").click();
    await until(
      async () =>
        ((await taskRecord(window, taskId))?.archivedAt ?? null) !== null,
      "确认归档后任务应已归档"
    );
    await until(
      async () =>
        (await taskSessions(window, taskId)).every(
          (session) => session.status === "exited"
        ),
      "确认归档后存活会话应被关闭"
    );
    console.log("[e2e] 归档确认卡确认路径：先杀后归档落账");

    // 重启恢复与归档全程零模型请求（08 票「重启不重放」语义对照）
    assert(
      requestCount() === requestCountAfterRound,
      `重启恢复与归档不应触发模型请求：${requestCount()}`
    );

    await closeApp(app);
    app = null;
    console.log("[e2e] 终端会话重启恢复 + 生命周期硬边通过 ✅");
  } catch (error) {
    console.error("[e2e] 终端会话重启恢复失败 ❌", error);
    process.exitCode = 1;
    if (app) {
      try {
        await closeApp(app);
      } catch {
        // 已关闭
      }
    }
  } finally {
    server.close();
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

await main();
