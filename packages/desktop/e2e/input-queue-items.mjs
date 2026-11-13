// E2E（票 03）：队列条目操作——单条删除、取回编辑（保存原地更新/取消还原草稿）、
// 拖拽重排与「正在发出」锁定。真实 Electron 生产产物 + 本地 mock SSE（响应闸门
// 挂起，不依赖固定时长）；全程只经用户界面与真实 IPC。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:input-queue-items（先 pnpm build）。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";

import {
  assert,
  closeApp,
  launchApp,
  prepareDraft,
  startMockProvider,
  untilDraft,
} from "./helpers.mjs";

/** 等待队列预览按给定顺序呈现（真实交互结果，非静态 markup 断言） */
async function untilQueueOrder(window, texts) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const previews = window.getByTestId("queue-item-preview");
    const current = [];
    for (let index = 0; index < (await previews.count()); index += 1)
      current.push((await previews.nth(index).textContent()) ?? "");
    if (
      current.length === texts.length &&
      current.every((text, i) => text.includes(texts[i]))
    )
      return current;
    assert(
      Date.now() < deadline,
      `队列顺序未达到 ${JSON.stringify(texts)}（当前 ${JSON.stringify(current)}）`
    );
    await delay(100);
  }
}

async function main() {
  const gates = new Map();
  const requests = [];
  const mock = await startMockProvider((ctx, { body }) => {
    const text = JSON.parse(body).messages.findLast(
      (message) => message.role === "user"
    ).content;
    requests.push(text);
    gates.set(text, ctx);
    ctx.send({ delta: { content: `${text}执行中` }, finish_reason: null });
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-queue-items-"));
  mkdirSync(join(homeDir, "workspace"));

  let app;
  async function finish(text) {
    const deadline = Date.now() + 15_000;
    while (!gates.has(text)) {
      assert(Date.now() < deadline, `未收到模型请求：${text}`);
      await delay(50);
    }
    gates.get(text).finishWith("stop");
  }
  try {
    // 0) 启动 → 设置页创建 Profile（指向本地 mock）
    const launched = await launchApp({ homeDir });
    app = launched.app;
    const window = launched.window;
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const form = window.locator("form");
    await form.getByLabel("名称").fill("Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${mock.port}/v1`);
    await form.getByLabel("API Key").fill("sk-e2e");
    await form.getByLabel("模型").fill("mock-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Mock").first().waitFor();
    await window.getByTestId("settings-back").click();

    await prepareDraft(window, { approvalMode: "assist" });
    const input = window.getByTestId("composer-input");
    await input.fill("首轮");
    await input.press("Enter");
    await window.getByText("首轮执行中").first().waitFor();

    // ① 回复进行中入队三条（Enter 真实提交，不绕过 composer）
    for (const text of ["排队甲", "排队乙", "排队丙"]) {
      await input.fill(text);
      await input.press("Enter");
      await untilDraft(window, "", `入队 ${text} 后输入框未清空`);
    }
    await untilQueueOrder(window, ["排队甲", "排队乙", "排队丙"]);

    // ② 单条删除：作废「排队丙」，队列只剩两条
    await window
      .getByTestId("queue-item")
      .filter({ hasText: "排队丙" })
      .getByTestId("queue-item-remove")
      .click();
    await window
      .getByTestId("queue-item")
      .filter({ hasText: "排队丙" })
      .waitFor({ state: "detached" });
    await untilQueueOrder(window, ["排队甲", "排队乙"]);
    console.log("[e2e] 单条删除：真实点击删除，条目立即作废消失");

    // ③ 取回编辑：点击「排队甲」载入输入框 → 修订 → 保存原地更新（顺序不变）
    await window
      .getByTestId("queue-item")
      .filter({ hasText: "排队甲" })
      .getByTestId("queue-item-preview")
      .click();
    await untilDraft(window, "排队甲", "点击取回后输入框未载入条目原文");
    await input.fill("排队甲（修订）");
    await window.getByTestId("composer-save-edit").click();
    await untilQueueOrder(window, ["排队甲（修订）", "排队乙"]);
    await untilDraft(window, "", "保存编辑后输入框未清空");
    console.log("[e2e] 取回编辑：保存后原位置更新，顺序未变");

    // ④ 取消编辑：条目原样保留，输入框还原进入编辑前的草稿
    await input.fill("我的临时草稿");
    await window
      .getByTestId("queue-item")
      .filter({ hasText: "排队乙" })
      .getByTestId("queue-item-preview")
      .click();
    await untilDraft(window, "排队乙", "第二次取回未载入条目原文");
    await window
      .getByTestId("queue-item")
      .filter({ hasText: "排队乙" })
      .getByTestId("queue-item-cancel-edit")
      .click();
    await untilDraft(window, "我的临时草稿", "取消编辑未还原输入框草稿");
    await untilQueueOrder(window, ["排队甲（修订）", "排队乙"]);
    console.log("[e2e] 取消编辑：条目原文保留，输入框草稿还原");

    // ⑤ 拖拽重排：把「排队乙」拖到「排队甲（修订）」之前，消费顺序随之改变
    const grab = window
      .getByTestId("queue-item")
      .filter({ hasText: "排队乙" })
      .getByTestId("queue-item-drag");
    const dropTarget = window
      .getByTestId("queue-item")
      .filter({ hasText: "排队甲（修订）" });
    await grab.dragTo(dropTarget);
    await untilQueueOrder(window, ["排队乙", "排队甲（修订）"]);
    console.log("[e2e] 拖拽重排：真实拖放后顺序即时改变");

    // ⑥ 消费按新顺序进行；正在发出的条目区别显示且锁定
    await finish("首轮");
    await window.getByText("排队乙执行中").first().waitFor({ timeout: 30_000 });
    const sendingRow = window.getByTestId("queue-item-sending");
    await sendingRow.waitFor({ timeout: 10_000 });
    assert(
      ((await sendingRow.textContent()) ?? "").includes("排队乙"),
      "正在发出的条目应为「排队乙」"
    );
    // 锁定：sending 行没有删除/取回编辑/拖拽入口；点击不改动输入框
    assert(
      (await sendingRow.getByTestId("queue-item-remove").count()) === 0,
      "正在发出的条目不应有删除入口"
    );
    await sendingRow.click();
    await untilDraft(window, "我的临时草稿", "点击发送中条目不应改动输入框");
    console.log("[e2e] 正在发出：区别显示且锁定，不可操作");

    // ⑦ 剩余条目按重排后的顺序消费完，队列条消失，请求顺序精确
    await finish("排队乙");
    await window
      .getByText("排队甲（修订）执行中")
      .first()
      .waitFor({ timeout: 30_000 });
    await finish("排队甲（修订）");
    await window
      .getByTestId("queue-bar")
      .waitFor({ state: "detached", timeout: 15_000 });
    await delay(600);
    assert(
      JSON.stringify(requests) ===
        JSON.stringify(["首轮", "排队乙", "排队甲（修订）"]),
      `模型请求顺序应为重排后顺序（实际 ${JSON.stringify(requests)}）`
    );
    console.log("[e2e] 消费按重排顺序完成，删除条目未被请求，队列条消失");

    await closeApp(app);
    console.log("[e2e] 队列条目操作冒烟通过 ✅");
  } catch (error) {
    console.error("[e2e] 队列条目操作失败 ❌", error);
    process.exitCode = 1;
    try {
      await closeApp(app);
    } catch {
      // 已关闭
    }
  } finally {
    mock.server.close();
    mock.server.closeAllConnections();
    rmSync(homeDir, { recursive: true, force: true });
  }
}
await main();
