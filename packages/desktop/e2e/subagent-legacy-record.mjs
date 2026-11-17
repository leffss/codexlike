// E2E（工单 05，ADR 0021 旧数据回退）：改造前格式的记录恢复照旧显示。
// 旧格式 = 仅一条 spawn_subagent 的 tool_calls 行（委派参数 + 报告 output +
// thinking 全文拼接在 reasoning 列），子代理三表无行。造库手段：先真实跑一条
// 普通任务让应用自建库（schema 全列就位），closeApp 后用 node:sqlite 直接向
// messages / tool_calls 插入旧格式行（时间戳排在既有消息之后，transcript 合并
// 顺序稳定），重启后断言：
// 1) 走 subagentFromToolRecord 旧路径：报告可读、状态 done；
// 2) 无新路径副作用：工具清单空、无起止时间（已用时不渲染）、思考单段拼接。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:subagent-legacy（先 pnpm build）。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  assert,
  closeApp,
  collapseSubagentList,
  launchApp,
  openSubagentDetail,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

const FIRST_MESSAGE = "旧格式前奏消息";
const FIRST_REPLY = "旧格式前奏回答。";
const LEGACY_TASK = "旧格式委派说明标记：调研入口并汇报";
const LEGACY_REPORT = "旧格式最终报告标记：调研完成，共 2 个入口。";
/** 旧格式（票 02）思考全文拼接在 tool_calls.reasoning 列 */
const LEGACY_REASONING = "旧格式思考拼接标记第一段\n旧格式思考拼接标记第二段";

/**
 * 向既有库注入旧格式行（应用已 close，库无并发占用）：
 * user（委派指令）→ tool_calls(spawn_subagent) → assistant（收尾），
 * created_at 用未来递增时间戳，稳定排在既有消息之后（transcript 按时序合并）。
 */
function injectLegacyRows(dbPath, taskId) {
  const db = new DatabaseSync(dbPath);
  try {
    const base = Date.now() + 60_000;
    const at = (offset) => new Date(base + offset).toISOString();
    db.prepare(
      "INSERT INTO messages (id, task_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)"
    ).run(randomUUID(), taskId, "旧格式委派指令", at(1000));
    db.prepare(
      "INSERT INTO tool_calls (id, task_id, tool_name, arguments, output, is_error, reasoning, created_at) VALUES (?, ?, 'spawn_subagent', ?, ?, 0, ?, ?)"
    ).run(
      randomUUID(),
      taskId,
      JSON.stringify({ task: LEGACY_TASK }),
      LEGACY_REPORT,
      LEGACY_REASONING,
      at(2000)
    );
    db.prepare(
      "INSERT INTO messages (id, task_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)"
    ).run(randomUUID(), taskId, "旧格式收尾回答", at(3000));
  } finally {
    db.close();
  }
}

async function main() {
  const model = await startMockProvider((ctx, { body }) => {
    if (body.includes(FIRST_MESSAGE)) {
      ctx.textRound(FIRST_REPLY);
      return;
    }
    ctx.res.writeHead(422);
    ctx.res.end("unexpected request");
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-sub-legacy-"));
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);

  let app;
  try {
    // 1) 真实跑一条普通任务：应用自建库（全部列与索引就位），之后手工注入
    const first = await launchApp({ homeDir, workspaceDir });
    app = first.app;
    let window = first.window;
    await window.evaluate(async (port) => {
      await window.codexlike.providerProfiles.create({
        name: "Legacy Mock",
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: "sk-e2e",
        models: ["mock-model"],
      });
    }, model.port);
    await prepareDraft(window, { approvalMode: "assist" });
    await window.getByTestId("composer-input").fill(FIRST_MESSAGE);
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: FIRST_REPLY })
      .waitFor({ timeout: 20_000 });
    await closeApp(app);

    // 2) 旧格式行注入（单任务库：取唯一 task 行）
    const dbPath = join(homeDir, "task-workbench.db");
    const probe = new DatabaseSync(dbPath);
    const tasks = probe
      .prepare("SELECT id FROM tasks")
      .all()
      .map((row) => row.id);
    probe.close();
    assert(tasks.length === 1, `预期单任务库，实际 ${tasks.length} 个任务`);
    injectLegacyRows(dbPath, tasks[0]);
    console.log("[e2e] 旧格式 spawn 行已注入（无子代理三表行）");

    // 3) 重启：打开任务，断言旧路径照旧、无新路径副作用
    const second = await launchApp({ homeDir, workspaceDir });
    app = second.app;
    window = second.window;
    await window
      .getByTestId("task-item")
      .filter({ hasText: FIRST_MESSAGE })
      .first()
      .click();
    await window
      .getByTestId("message-user")
      .filter({ hasText: "旧格式委派指令" })
      .waitFor({ timeout: 15_000 });
    await window
      .locator(
        '[data-testid="subagent-stream-marker-toggle"][data-subagent-state="done"]'
      )
      .waitFor({ timeout: 15_000 });
    const panel = await openSubagentDetail(window);

    // 旧路径行为：报告 = 行 output、委派说明 = 行参数、思考单段拼接
    const reportText = await panel.getByTestId("subagent-report").textContent();
    assert(
      reportText !== null && reportText.includes(LEGACY_REPORT),
      `旧记录报告不可回读：${reportText ?? "(空)"}`
    );
    const delegationText = await panel
      .getByTestId("subagent-delegation-text")
      .textContent();
    assert(
      delegationText !== null && delegationText.includes(LEGACY_TASK),
      `旧记录委派说明不可回读：${delegationText ?? "(空)"}`
    );
    const thinkingBlock = panel.getByTestId("subagent-thinking-block");
    await thinkingBlock.waitFor({ timeout: 10_000 });
    // focus 定位展开的浮层盖住详情区拦截点击——收起后再展开思考块
    await collapseSubagentList(window);
    await thinkingBlock.getByTestId("subagent-thinking-toggle").click();
    const thinkingText = await thinkingBlock
      .getByTestId("subagent-thinking-content")
      .textContent();
    assert(
      thinkingText !== null &&
        thinkingText.includes("旧格式思考拼接标记第一段") &&
        thinkingText.includes("旧格式思考拼接标记第二段"),
      `旧记录思考拼接不可回读：${thinkingText ?? "(空)"}`
    );
    assert(
      (await thinkingBlock.getByTestId("subagent-thinking-round-2").count()) ===
        0,
      "旧记录思考应单段呈现（无轮边界可拆）"
    );

    // 无新路径副作用：工具清单恒空、无起止时间（旧记录无从重建）
    assert(
      (await panel.getByTestId("subagent-tools").count()) === 0,
      "旧记录不应重建工具清单（无逐条数据）"
    );
    assert(
      (await panel.getByTestId("subagent-elapsed").count()) === 0,
      "旧记录无起止时间，不应显示已用时"
    );
    assert(
      (await panel.getByTestId("subagent-body-block").count()) === 0,
      "旧记录无逐轮正文数据，不应出现正文折叠块"
    );
    console.log("[e2e] 旧记录回退：报告/委派说明/思考拼接照旧，无新路径副作用");

    await closeApp(app);
    console.log("[e2e] 工单 05 旧记录回退场景通过 ✅");
  } catch (error) {
    console.error("[e2e] 旧记录回退场景失败 ❌", error);
    process.exitCode = 1;
    try {
      await closeApp(app);
    } catch {
      // 已关闭
    }
  } finally {
    model.server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
}

await main();
