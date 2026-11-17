// E2E（工单 05，ADR 0021）：运行中被杀 + 排队中被杀的留痕回看。
// 路径：主模型单响应并行委派 4 路（默认并发上限 3 → 甲乙丙运行、丁排队）→
// 三个运行中子代理各完成第一轮（思考 + 正文 + read_file 工具，均已落库）→
// 第二轮请求在 mock 挂起（应用停在运行中）→ taskkill /T /F 强杀进程树
// （真实被杀路径，先例 exit-recovery：不走退出确认屏障）→ 同 homeDir 重启：
// 1) 主任务列表项「已中断」；四条委派标记行与列表项全部 interrupted；
// 2) 运行中被杀（甲）：已发生部分完整回看（思考/正文/工具清单）+ 留痕提示；
// 3) 排队中被杀（丁）：留痕 + 委派说明可读，无正文/思考/工具（未启动），
//    且无起止时间（startedAt 缺失）——与运行中被杀（有起止时间）判别。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:subagent-interrupted（先 pnpm build）。
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  assert,
  closeApp,
  collapseSubagentList,
  launchApp,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

/** 四路委派说明（甲乙丙丁各不同，作为恢复后定位与判别的稳定标记） */
const TASKS = [
  "运行委派甲：读取 note.txt 并总结",
  "运行委派乙：核对 note.txt 内容",
  "运行委派丙：抽查 note.txt 细节",
  "排队委派丁：等待前面的委派结束后再调研",
];
const NOTE_CONTENT = "中断留痕预置文件内容XYZ";
const SUB_REASONING_1 = "中断留痕子代理第一轮思考AAA";
const SUB_TEXT_1 = "中断留痕子代理第一轮正文：已读取文件。";
const SUBAGENT_SYSTEM_MARK = "CodexLike 的子代理";
const MAIN_TASK = "四路并行委派调研笔记";
/** 挂起的子代理第二轮请求序号集合（杀进程时随连接断开，收尾统一清理） */
const heldRounds = new Set();

/** 强杀进程树（Windows taskkill /T /F，先例 exit-recovery），不走退出屏障 */
async function killApp(app) {
  const child = app.process();
  const done = new Promise((resolve) => child.once("exit", () => resolve()));
  if (process.platform === "win32") {
    await new Promise((resolve) =>
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () =>
        resolve()
      )
    );
  } else {
    child.kill("SIGKILL");
  }
  await done;
}

/** 等待条件成立（轮询 + 截止期断言，exit-recovery until 同款） */
async function until(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    assert(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 按委派说明定位该子代理的消息流标记行（恢复后四个标记行互为同构） */
function markerOf(window, task) {
  return window
    .getByTestId("subagent-stream-marker-toggle")
    .filter({ hasText: task });
}

async function main() {
  const model = await startMockProvider((ctx, { body }) => {
    const isSub = body.includes(SUBAGENT_SYSTEM_MARK);
    const subIndex = TASKS.findIndex((task) => body.includes(task));
    if (isSub && !body.includes(NOTE_CONTENT)) {
      // 子代理第一轮：思考 + 正文 + read_file（call id 按委派序号唯一，
      // 避免跨子代理的 subagent_tool_calls 主键冲突）
      ctx.send({
        delta: { reasoning_content: SUB_REASONING_1 },
        finish_reason: null,
      });
      ctx.send({ delta: { content: SUB_TEXT_1 }, finish_reason: null });
      ctx.toolCallRound(`call-sub-${subIndex}-read`, "read_file", {
        path: "note.txt",
      });
      return;
    }
    if (isSub) {
      // 子代理第二轮（工具结果已回填）：挂起不答——应用停在「运行中」，
      // 等待被杀；第一轮内容此刻已全部落库（轮终态即写 + 工具完成即写）
      heldRounds.add(subIndex);
      return;
    }
    if (body.includes(MAIN_TASK)) {
      // 主任务首轮：单响应并行委派 4 路（OpenAI 兼容多 tool_calls 一帧）
      ctx.send({
        delta: {
          tool_calls: TASKS.map((task, index) => ({
            index,
            id: `call-delegate-${index}`,
            type: "function",
            function: {
              name: "spawn_subagent",
              arguments: JSON.stringify({ task }),
            },
          })),
        },
        finish_reason: null,
      });
      setTimeout(() => ctx.finishWith("tool_calls"), 30);
      return;
    }
    ctx.res.writeHead(422);
    ctx.res.end("unexpected request");
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-sub-intr-"));
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);
  writeFileSync(join(workspaceDir, "note.txt"), NOTE_CONTENT);

  let app;
  try {
    const first = await launchApp({ homeDir, workspaceDir });
    app = first.app;
    const window = first.window;

    await window.evaluate(async (port) => {
      await window.codexlike.providerProfiles.create({
        name: "Interrupt Mock",
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: "sk-e2e",
        models: ["mock-model"],
      });
    }, model.port);
    await prepareDraft(window, { approvalMode: "assist" });
    await window.getByTestId("composer-input").fill(MAIN_TASK);
    await window.getByTestId("composer-send").click();

    // 等三个运行中子代理的第二轮请求都到 mock（此刻：第一轮思考/正文/工具
    // 已落库，丁仍排队，甲乙丙停在运行中）——1 主轮 + 3 子一轮 + 3 子二轮
    await until(
      () => model.requestCount() >= 7 && heldRounds.size >= 3,
      `子代理未全部进入第二轮挂起点（请求 ${model.requestCount()}，挂起 ${heldRounds.size}）`
    );
    console.log("[e2e] 甲乙丙运行中（第二轮挂起）、丁排队中：强杀应用");

    // 强杀进程树：真实被杀路径（不走退出确认屏障），先例 exit-recovery
    await killApp(app);
    app = null;

    // ---- 重启：同 homeDir 再启动，打开任务回看留痕 ----
    const second = await launchApp({ homeDir, workspaceDir });
    app = second.app;
    const restored = second.window;
    await restored
      .getByTestId("task-item")
      .filter({ hasText: MAIN_TASK })
      .first()
      .click();
    await restored.getByTestId("message-stream").waitFor({ timeout: 20_000 });

    // 1) 主任务被杀恢复为「已中断」
    await restored
      .getByTestId("task-item")
      .filter({ hasText: MAIN_TASK })
      .getByTestId("task-activity")
      .filter({ hasText: "已中断" })
      .waitFor({ timeout: 15_000 });

    // 2) 四条委派全部 interrupted：标记行 + 列表项（残留 queued/running
    //    行都被启动收尾补记 interrupted；spawn 行未落 → 标记行来自快照末尾留痕）
    await markerOf(restored, TASKS[0]).waitFor({ timeout: 15_000 });
    assert(
      (await restored
        .locator(
          '[data-testid="subagent-stream-marker-toggle"][data-subagent-state="interrupted"]'
        )
        .count()) === 4,
      "重启后四条委派标记行应全部为 interrupted"
    );
    // 点击甲的标记行打开右栏定位详情
    await markerOf(restored, TASKS[0]).click();
    const panel = restored.getByTestId("subagents-panel-body");
    await panel.waitFor({ timeout: 10_000 });
    await until(
      async () =>
        (await panel
          .locator(
            '[data-testid="subagent-rail-item"][data-subagent-state="interrupted"]'
          )
          .count()) === 4,
      "右栏列表四个委派应全部为 interrupted"
    );
    console.log("[e2e] 重启后：主任务已中断，四条委派留痕（interrupted）");

    // 3) 运行中被杀（甲）：已发生部分完整回看
    await panel.getByTestId("subagent-interrupted-note").waitFor({
      timeout: 10_000,
    });
    const delegationText = await panel
      .getByTestId("subagent-delegation-text")
      .textContent();
    assert(
      delegationText !== null && delegationText.includes(TASKS[0]),
      `甲的委派说明缺失：${delegationText ?? "(空)"}`
    );
    // 起止时间对齐全（启动收尾补记 completedAt）：列表行已用时定格。
    // 列表行（subagent-rail-item）只在浮层展开时渲染——先在浮层展开态
    // 断言，再收浮层做详情内点击（浮层遮罩盖住详情区拦截点击）
    const elapsedJia = panel
      .getByTestId("subagent-rail-item")
      .getByTestId("subagent-elapsed");
    assert(
      (await elapsedJia.count()) >= 1,
      "运行中被杀的委派应有起止时间（已用时定格）"
    );
    await collapseSubagentList(restored);
    const thinkingBlock = panel.getByTestId("subagent-thinking-block");
    await thinkingBlock.waitFor({ timeout: 10_000 });
    await thinkingBlock.getByTestId("subagent-thinking-toggle").click();
    const thinkingText = await thinkingBlock
      .getByTestId("subagent-thinking-content")
      .textContent();
    assert(
      thinkingText !== null && thinkingText.includes(SUB_REASONING_1),
      `运行中被杀的思考不可回看：${thinkingText ?? "(空)"}`
    );
    const bodyBlock = panel.getByTestId("subagent-body-block");
    await bodyBlock.waitFor({ timeout: 10_000 });
    await bodyBlock.getByTestId("subagent-body-toggle").click();
    const bodyText = await bodyBlock
      .getByTestId("subagent-body-content")
      .textContent();
    assert(
      bodyText !== null && bodyText.includes(SUB_TEXT_1),
      `运行中被杀的正文不可回看：${bodyText ?? "(空)"}`
    );
    const tools = panel.getByTestId("subagent-tools");
    await tools.waitFor({ timeout: 10_000 });
    const toolsText = await tools.textContent();
    assert(
      toolsText !== null && toolsText.includes("read_file"),
      `运行中被杀的工具清单不可回看：${toolsText ?? "(空)"}`
    );
    console.log("[e2e] 运行中被杀（甲）：思考/正文/工具清单/起止时间完整回看");

    // 4) 排队中被杀（丁）：留痕 + 委派说明可读，未启动（无任何过程内容）
    await markerOf(restored, TASKS[3]).click();
    await until(
      async () =>
        (await panel.getByTestId("subagent-interrupted-note").count()) === 1,
      "丁的详情未切换（留痕提示缺失）"
    );
    const dingText = await panel
      .getByTestId("subagent-delegation-text")
      .textContent();
    assert(
      dingText !== null && dingText.includes(TASKS[3]),
      `排队中被杀的委派说明缺失：${dingText ?? "(空)"}`
    );
    assert(
      (await panel.getByTestId("subagent-body-block").count()) === 0 &&
        (await panel.getByTestId("subagent-thinking-block").count()) === 0 &&
        (await panel.getByTestId("subagent-tools").count()) === 0,
      "排队中被杀的委派未启动，不应有正文/思考/工具清单"
    );
    // 排队未启动 → 无 startedAt → 该列表行无已用时（与运行中被杀判别）
    assert(
      (await panel.getByTestId("subagent-rail-item").count()) === 4,
      "列表应仍含四个委派"
    );
    // rows 即列表项按钮本体：title 属性承载完整委派说明（文本被截断显示）
    const elapsedAll = await panel
      .getByTestId("subagent-rail-item")
      .evaluateAll((rows) =>
        rows.map((row) => ({
          task: row.querySelector("span[title]")?.getAttribute("title") ?? "",
          hasElapsed:
            row.querySelector('[data-testid="subagent-elapsed"]') !== null,
        }))
      );
    const dingRow = elapsedAll.find((row) => row.task === TASKS[3]);
    assert(dingRow !== undefined, "列表行中未找到丁");
    assert(
      dingRow.hasElapsed === false,
      "排队中被杀的委派无起止时间（不应显示已用时）"
    );
    const jiaRow = elapsedAll.find((row) => row.task === TASKS[0]);
    assert(jiaRow?.hasElapsed === true, "运行中被杀的委派应显示已用时");
    console.log("[e2e] 排队中被杀（丁）：委派说明留痕，无过程内容与起止时间");

    await closeApp(app);
    console.log("[e2e] 工单 05 中断留痕场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 中断留痕场景失败 ❌", error);
    process.exitCode = 1;
    try {
      await closeApp(app);
    } catch {
      // 已关闭或已被强杀
    }
  } finally {
    // 挂起的第二轮请求连接先断开再关 server（exit-recovery 同款清理）
    model.server.closeAllConnections();
    model.server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
}

await main();
