// 统一用户交互 E2E：真实 Electron + 隔离数据目录 + 本地 OpenAI 兼容 mock。
// 公开边界：用户界面、sessions IPC、发送给 provider 的真实请求；不读取数据库或组件内部状态。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:interactions（先 build）。
// 可用 CODEXLIKE_E2E_INTERACTION_CASE=questions|queue|cancel 单独重跑一个场景。
import { deepStrictEqual } from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import {
  assert,
  closeApp,
  launchApp,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

const SUBAGENT_SYSTEM_MARK = "CodexLike 的子代理";
const QUESTION_CALL = "call-four-questions";
const LONG_DESCRIPTION =
  "这是需要完整阅读的长选项说明，请确认窄窗口中内容可以换行且操作区仍然可达。".repeat(
    10
  );
const QUESTIONS = [
  {
    id: "target",
    header: "运行环境",
    question: "选择本次运行环境？",
    multiSelect: false,
    options: [
      { id: "local", label: "本地环境", description: LONG_DESCRIPTION },
      { id: "staging", label: "预发布环境" },
    ],
  },
  {
    id: "checks",
    header: "验证方式",
    question: "选择需要执行的检查，可补充自定义内容？",
    multiSelect: true,
    options: [
      { id: "unit", label: "单元测试" },
      { id: "e2e", label: "端到端测试" },
      { id: "lint", label: "格式检查" },
    ],
  },
  {
    id: "notes",
    header: "补充说明",
    question: "还有哪些需要保留的说明？",
    multiSelect: false,
    options: [
      { id: "none", label: "没有补充" },
      { id: "later", label: "稍后补充" },
    ],
  },
  {
    id: "optional",
    header: "可选信息",
    question: "是否需要通知其他成员？",
    multiSelect: false,
    options: [
      { id: "notify", label: "发送通知" },
      { id: "silent", label: "不发送通知" },
    ],
  },
];
const SIMPLE_QUESTIONS = [
  {
    id: "choice",
    header: "确认方向",
    question: "请选择接下来要做的工作？",
    multiSelect: false,
    options: [
      { id: "continue", label: "继续当前任务" },
      { id: "adjust", label: "调整当前任务" },
    ],
  },
];

// 只轮询 mock 请求和公开 IPC 快照；界面等待一律使用 locator/waitForFunction。
async function waitUntil(predicate, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert(Date.now() < deadline, message);
    await delay(25);
  }
}

function toolResult(body, callId) {
  return JSON.parse(body).messages.find(
    (message) => message.role === "tool" && message.tool_call_id === callId
  )?.content;
}

function lastUserText(body) {
  return (
    JSON.parse(body)
      .messages.filter((message) => message.role === "user")
      .at(-1)?.content ?? ""
  );
}

function ask(ctx, callId, questions = SIMPLE_QUESTIONS) {
  ctx.toolCallRound(callId, "ask_user_question", { questions });
}

async function setupProfile(window, port) {
  await window.getByTestId("settings-open").click();
  const profiles = window.locator("section").filter({
    has: window.getByRole("heading", {
      name: "Provider Profiles",
      exact: true,
    }),
  });
  await profiles
    .getByRole("button", { name: "+ 新建 Profile", exact: true })
    .click();
  const form = window.locator("form");
  await form.getByLabel("名称", { exact: true }).fill("Interaction Mock");
  await form
    .getByLabel("baseURL", { exact: true })
    .fill(`http://127.0.0.1:${port}/v1`);
  await form.getByLabel("API Key", { exact: true }).fill("sk-isolated-e2e");
  await form.getByLabel("模型", { exact: true }).fill("mock-model");
  await form.getByRole("button", { name: "创建", exact: true }).click();
  await profiles.getByText("Interaction Mock", { exact: true }).waitFor();
  await window.getByTestId("subagent-concurrency-input").fill("2");
  await window.getByTestId("subagent-settings-save").click();
  await window
    .getByTestId("subagent-settings-message")
    .filter({ hasText: "已保存" })
    .waitFor();
  await window.getByTestId("settings-back").click();
}

async function send(window, text) {
  await window.getByTestId("composer-input").fill(text);
  await window.getByTestId("composer-send").click();
}

async function waitQuestion(window, index, total = 4) {
  await window.getByTestId("interaction-panel").waitFor({ timeout: 20_000 });
  await window
    .getByTestId("question-progress")
    .filter({ hasText: `第 ${index} / ${total} 题` })
    .waitFor();
}

async function waitText(window, text) {
  await window
    .getByTestId("message-assistant")
    .filter({ hasText: text })
    .waitFor({ timeout: 20_000 });
  await window.getByTestId("composer-send").waitFor();
}

async function assertReadOnlyHistory(window) {
  for (const history of await window.getByTestId("interaction-history").all()) {
    assert(
      (await history.locator("button,input,textarea,select").count()) === 0,
      "消息流交互摘要不应含可操作入口"
    );
  }
}

async function assertPanelLayout(window, theme, screenshotDir) {
  const measurements = await window
    .getByTestId("interaction-panel")
    .evaluate((panel) => {
      const rect = panel.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        panelOverflow: panel.scrollWidth - panel.clientWidth,
        scrollable: [...panel.querySelectorAll("*")].some(
          (node) =>
            node.scrollHeight > node.clientHeight &&
            ["auto", "scroll"].includes(getComputedStyle(node).overflowY)
        ),
      };
    });
  assert(
    measurements.width > 100 && measurements.height > 100,
    `${theme} 面板没有有效尺寸`
  );
  assert(
    measurements.x >= 0 &&
      measurements.y >= 0 &&
      measurements.right <= measurements.viewportWidth + 1 &&
      measurements.bottom <= measurements.viewportHeight + 1,
    `${theme} 窄窗面板越界：${JSON.stringify(measurements)}`
  );
  assert(
    measurements.pageOverflow <= 1 && measurements.panelOverflow <= 1,
    `${theme} 长内容导致横向溢出：${JSON.stringify(measurements)}`
  );
  assert(measurements.scrollable, `${theme} 长选项区域必须可以独立滚动`);
  await window.getByTestId("question-title").scrollIntoViewIfNeeded();
  await window.screenshot({
    path: join(screenshotDir, `questions-${theme}-narrow-top.png`),
  });
  const next = window.getByTestId("question-next");
  await next.scrollIntoViewIfNeeded();
  const bounds = await next.boundingBox();
  assert(
    bounds !== null &&
      bounds.y >= 0 &&
      bounds.y + bounds.height <= measurements.viewportHeight + 1,
    `${theme} 下一题按钮无法触达`
  );
  await window.screenshot({
    path: join(screenshotDir, `questions-${theme}-narrow.png`),
  });
}

async function withScenario(name, onChat, run) {
  const homeDir = mkdtempSync(
    join(tmpdir(), `codexlike-interactions-${name}-`)
  );
  mkdirSync(join(homeDir, "workspace"), { recursive: true });
  const mock = await startMockProvider(onChat);
  let active;
  const fixture = {
    ...mock,
    homeDir,
    async launch() {
      active = await launchApp({ homeDir });
      active.window.setDefaultTimeout(15_000);
      return active;
    },
    async close() {
      if (active !== undefined) await closeApp(active.app);
      active = undefined;
    },
  };
  try {
    const first = await fixture.launch();
    await setupProfile(first.window, mock.port);
    await run({ ...fixture, ...first });
    console.log(`[e2e:interactions] ${name} 通过`);
  } catch (error) {
    // 诊断留在独立临时工件目录，不与要清理的数据目录混放。
    const artifacts = mkdtempSync(
      join(tmpdir(), `codexlike-interaction-failure-${name}-`)
    );
    writeFileSync(
      join(artifacts, "provider-requests.json"),
      JSON.stringify(
        mock.seenBodies.map((body) => JSON.parse(body)),
        null,
        2
      )
    );
    if (active !== undefined) {
      try {
        await active.window.screenshot({
          path: join(artifacts, "failure.png"),
        });
        writeFileSync(
          join(artifacts, "visible-dom.txt"),
          await active.window.locator("body").innerText()
        );
      } catch (diagnosticError) {
        console.warn("[e2e:interactions] 界面诊断采集失败", diagnosticError);
      }
    }
    console.error(`[e2e:interactions] ${name} 失败诊断 ${artifacts}`);
    throw error;
  } finally {
    await fixture.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
    rmSync(homeDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

async function questionsScenario() {
  let initialRequest;
  await withScenario(
    "questions",
    (ctx, { body }) => {
      if (String(lastUserText(body)).includes("验证持久答案"))
        return ctx.textRound("持久答案已收到");
      if (toolResult(body, QUESTION_CALL) !== undefined)
        return ctx.textRound("整组答案已收到");
      initialRequest = ctx;
    },
    async ({ app, window, seenBodies, launch, close }) => {
      await prepareDraft(window);
      const sessionA = window
        .getByTestId("session-item")
        .filter({ hasText: "开始四题混合问答" });
      await window
        .getByTestId("approval-mode-select")
        .selectOption("full-access");
      await window.getByTestId("full-access-confirm-ok").click();
      await window
        .getByTestId("full-access-confirm-dialog")
        .waitFor({ state: "hidden" });
      await window.waitForFunction(
        () =>
          document.querySelector('[data-testid="approval-mode-select"]')
            ?.value === "full-access"
      );
      await send(window, "开始四题混合问答");
      await waitUntil(
        () => initialRequest !== undefined,
        "模型没有收到开始问答请求"
      );
      // mock 尚未发工具调用，先留下普通草稿，验证交互覆盖输入区而不是清空草稿。
      const draftA = "问答完成后再发送的普通草稿 A";
      await window.getByTestId("composer-input").fill(draftA);
      ask(initialRequest, QUESTION_CALL, QUESTIONS);
      await waitQuestion(window, 1);
      const requestId = await window
        .getByTestId("interaction-panel")
        .getAttribute("data-interaction-id");
      assert(requestId, "面板未暴露交互标识");
      await sessionA.getByText("等待用户").waitFor();
      assert(seenBodies.length === 1, "问答未提交前不应继续请求模型");
      assert(
        (await window.getByTestId("composer-input").isVisible()) === false,
        "等待问答时普通聊天框应让位于交互面板"
      );
      await assertReadOnlyHistory(window);
      assert(
        await window.getByTestId("question-next").isDisabled(),
        "未答题时不能继续，必须明确选择、填写或忽略"
      );
      assert(
        await window.getByTestId("question-prev").isDisabled(),
        "第一题不应允许继续向前翻页"
      );

      // 键盘单选 + 自定义互斥；回看时最终选回预发布，而不是提交早先的本地值。
      const local = window.getByTestId("question-option-local");
      await local.focus();
      await local.press("Space");
      assert(await local.isChecked(), "空格未选中单选选项");
      await window.getByTestId("question-custom").fill("临时自定义环境");
      assert(!(await local.isChecked()), "单选自定义回答应清除预设选项");
      await local.check();
      assert(
        (await window.getByTestId("question-custom").inputValue()) === "",
        "单选选回预设项应清空互斥文本"
      );

      const screenshotDir = mkdtempSync(
        join(tmpdir(), "codexlike-interaction-screenshots-")
      );
      console.log(`[e2e:interactions] 布局截图目录 ${screenshotDir}`);
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(640, 700)
      );
      for (const theme of ["light", "dark"]) {
        if (
          (await window.evaluate(
            () => document.documentElement.dataset.theme ?? "light"
          )) !== theme
        ) {
          await window.getByTestId("theme-toggle").click();
        }
        await window.waitForFunction(
          (expected) => document.documentElement.dataset.theme === expected,
          theme
        );
        await assertPanelLayout(window, theme, screenshotDir);
      }
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(1280, 800)
      );

      await window.getByTestId("question-next").click();
      await waitQuestion(window, 2);
      await window.getByTestId("question-option-unit").check();
      await window.getByTestId("question-option-e2e").check();
      const multiText = "保留中文输入法内容，并补充手工验收";
      const custom = window.getByTestId("question-custom");
      await custom.focus();
      await custom.dispatchEvent("compositionstart", { data: "保留" });
      await custom.fill(multiText);
      await custom.dispatchEvent("keydown", {
        key: "Enter",
        code: "Enter",
        isComposing: true,
        keyCode: 229,
      });
      await custom.dispatchEvent("compositionend", { data: multiText });
      await waitQuestion(window, 2);
      assert((await custom.inputValue()) === multiText, "IME 合成输入丢失");
      assert(
        (await window.getByTestId("question-option-unit").isChecked()) &&
          (await window.getByTestId("question-option-e2e").isChecked()),
        "多选补充文本不应清除已选项"
      );
      assert(
        seenBodies.length === 1,
        "IME Enter 不应提交整组问答或发送聊天消息"
      );

      // 切到新会话并保留另一份草稿，再进入设置；返回后恢复同一题与回答。
      await window.getByTestId("new-session").click();
      const draftB = "普通会话独立草稿 B";
      await window.getByTestId("composer-input").fill(draftB);
      await window.getByTestId("settings-open").click();
      await window.getByTestId("settings-back").click();
      assert(
        (await window.getByTestId("composer-input").inputValue()) === draftB,
        "设置返回丢失普通会话草稿"
      );
      await sessionA.click();
      await waitQuestion(window, 2);
      assert(
        (await window
          .getByTestId("interaction-panel")
          .getAttribute("data-interaction-id")) === requestId,
        "切会话恢复了错误的交互"
      );
      assert(
        (await custom.inputValue()) === multiText &&
          (await window.getByTestId("question-option-e2e").isChecked()),
        "切会话丢失多选及自定义草稿"
      );
      await window.getByTestId("settings-open").click();
      await window.getByTestId("settings-back").click();
      await waitQuestion(window, 2);
      assert((await custom.inputValue()) === multiText, "设置返回丢失问答草稿");

      await window.getByTestId("question-next").click();
      await waitQuestion(window, 3);
      const note = "文本回答独立标记：需保留上下文";
      await custom.fill(note);
      await custom.press("End");
      await custom.press("Shift+Enter");
      await custom.press("Backspace");
      assert(
        (await custom.inputValue()) === note,
        "textarea 键盘编辑破坏文本回答"
      );
      await window.getByTestId("question-next").click();
      await waitQuestion(window, 4);
      await window.getByTestId("question-option-notify").check();
      await window.getByTestId("question-skip").click();
      await waitQuestion(window, 4);
      assert(seenBodies.length === 1, "忽略当前题不能提前提交整组问答");
      await window.getByTestId("question-prev").click();
      await waitQuestion(window, 3);
      assert(
        (await custom.inputValue()) === note,
        "跳过第四题不应丢失第三题答案"
      );
      await window.getByTestId("question-prev").click();
      await waitQuestion(window, 2);
      await window.getByTestId("question-option-unit").uncheck();
      await window.getByTestId("question-option-lint").check();
      await window.getByTestId("question-prev").click();
      await waitQuestion(window, 1);
      await window.getByTestId("question-option-staging").check();
      for (const index of [2, 3, 4]) {
        await window.getByTestId("question-next").click();
        await waitQuestion(window, index);
      }
      assert(seenBodies.length === 1, "翻页/回看修改不应发出中间答案");
      await window.getByTestId("question-submit").click();
      await waitText(window, "整组答案已收到");
      assert(
        seenBodies.length === 2,
        `整组提交应仅继续一次模型请求，实际 ${seenBodies.length}`
      );
      const result = JSON.parse(toolResult(seenBodies[1], QUESTION_CALL));
      const expected = [
        {
          questionId: "target",
          status: "answered",
          selectedOptionIds: ["staging"],
          text: "",
        },
        {
          questionId: "checks",
          status: "answered",
          selectedOptionIds: ["e2e", "lint"],
          text: multiText,
        },
        {
          questionId: "notes",
          status: "answered",
          selectedOptionIds: [],
          text: note,
        },
        {
          questionId: "optional",
          status: "skipped",
          selectedOptionIds: [],
          text: "",
        },
      ];
      for (const answer of expected) {
        const actual = result.answers.find(
          (item) => item.questionId === answer.questionId
        );
        deepStrictEqual(
          actual,
          answer,
          "真正工具结果与回看修改后的最终回答不符"
        );
      }
      assert(
        result.answers.length === 4,
        "工具结果应包含全部四题且仅第四题 skipped"
      );
      assert(
        (await window.getByTestId("composer-input").inputValue()) === draftA,
        "提交问答后未恢复原普通草稿"
      );
      assert(
        (await window.getByTestId("message-user").count()) === 1,
        "问答响应不应伪装成额外用户消息"
      );
      await assertReadOnlyHistory(window);
      await window.getByTestId("new-session").click();
      assert(
        (await window.getByTestId("composer-input").inputValue()) === draftB,
        "问答提交覆盖其他会话草稿"
      );
      await sessionA.click();

      // 重启后新轮请求仍包含持久快照，不能仅靠本轮 pending tool messages 假绿。
      const sessionId = await sessionA.getAttribute("data-session-id");
      await close();
      const restarted = await launch();
      window = restarted.window;
      await window
        .getByTestId("session-item")
        .filter({ hasText: "开始四题混合问答" })
        .click();
      await window
        .getByTestId("interaction-history")
        .filter({ hasText: "已回答" })
        .waitFor();
      await assertReadOnlyHistory(window);
      await send(window, "验证持久答案");
      await waitText(window, "持久答案已收到");
      const persistedMessages = JSON.parse(seenBodies.at(-1)).messages;
      const persisted = JSON.stringify(persistedMessages);
      const snapshotMessage = persistedMessages.find(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("<question-answers>")
      );
      assert(snapshotMessage !== undefined, "重启后的新轮请求缺少用户问答快照");
      const snapshots = JSON.parse(
        snapshotMessage.content
          .split("<question-answers>")[1]
          .split("</question-answers>")[0]
      );
      const snapshot = snapshots.find(
        (item) => item.interactionId === requestId
      );
      assert(snapshot?.answers.length === 4, "持久快照没有完整保存四题答案");
      assert(
        snapshot.answers.find((answer) => answer.questionId === "optional")
          ?.status === "skipped",
        "后续新轮丢失明确忽略标记"
      );
      for (const value of [
        "选择本次运行环境？",
        "预发布环境",
        "端到端测试",
        "格式检查",
        multiText,
        note,
      ]) {
        assert(
          persisted.includes(value),
          `新轮模型上下文缺少持久答案：${value}`
        );
      }
      const pending = await window.evaluate(
        (id) => window.codexlike.sessions.pendingInteractions(id),
        sessionId
      );
      assert(pending.length === 0, "已提交交互不应在重启后重新排队");
    }
  );
}

async function pendingCount(window, sessionId, count) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const records = await window.evaluate(
      (id) => window.codexlike.sessions.pendingInteractions(id),
      sessionId
    );
    if (records.length === count) return records;
    assert(
      Date.now() < deadline,
      `待处理交互期望 ${count} 项，实际 ${records.length} 项`
    );
    await delay(25);
  }
}

async function expectFront(window, record, source) {
  await window
    .getByTestId("interaction-panel")
    .filter({
      has: window.getByTestId("interaction-source").filter({ hasText: source }),
    })
    .waitFor();
  assert(
    (await window
      .getByTestId("interaction-panel")
      .getAttribute("data-interaction-id")) === record.request.id,
    "面板未按 IPC 返回的 FIFO 顺序展示"
  );
  assert(
    (await window
      .getByTestId("interaction-panel")
      .getAttribute("data-interaction-kind")) === record.request.kind,
    "面板交互类型错误"
  );
}

async function queueScenario() {
  const taskA = "E2E并发子代理A：先问清实现方向";
  const taskB = "E2E并发子代理B：请求批准写入文件";
  const childContexts = new Map();
  await withScenario(
    "queue",
    (ctx, { body }) => {
      if (body.includes(SUBAGENT_SYSTEM_MARK)) {
        const task = body.includes(taskA) ? taskA : taskB;
        const callId = task === taskA ? "child-question" : "child-approval";
        if (toolResult(body, callId) !== undefined)
          return ctx.textRound(`${task}完成报告`);
        childContexts.set(task, ctx);
        return;
      }
      if (toolResult(body, "main-question") !== undefined)
        return ctx.textRound("并发问答审批全部完成");
      // 同一轮先启动两个子代理，再让主代理等待问答。子代理 HTTP 响应由测试按 UI 状态放行。
      ctx.send({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "spawn-a",
              type: "function",
              function: {
                name: "spawn_subagent",
                arguments: JSON.stringify({ task: taskA }),
              },
            },
            {
              index: 1,
              id: "spawn-b",
              type: "function",
              function: {
                name: "spawn_subagent",
                arguments: JSON.stringify({ task: taskB }),
              },
            },
            {
              index: 2,
              id: "main-question",
              type: "function",
              function: {
                name: "ask_user_question",
                arguments: JSON.stringify({ questions: SIMPLE_QUESTIONS }),
              },
            },
          ],
        },
        finish_reason: null,
      });
      ctx.finishWith("tool_calls");
    },
    async ({ window, homeDir, seenBodies }) => {
      // ADR 0010：先草稿，首次发送才建立会话；目录选择不创建项目。
      await window.getByTestId("new-session").click();
      await window.getByTestId("draft-select-workspace").click();
      await window.getByTestId("approval-mode-select").selectOption("ask");
      await send(window, "同时委派两个子代理，主代理也需要问答");
      const session = window
        .getByTestId("session-item")
        .filter({ hasText: "同时委派两个子代理" });
      await session.waitFor();
      const sessionId = await session.getAttribute("data-session-id");
      await waitQuestion(window, 1, 1);
      const first = await pendingCount(window, sessionId, 1);
      assert(first[0].request.source.kind === "main", "第一项必须是主代理问答");
      await waitUntil(() => childContexts.size === 2, "两个子代理未并发启动");
      ask(childContexts.get(taskA), "child-question");
      const second = await pendingCount(window, sessionId, 2);
      assert(second[1].request.source.task === taskA, "子代理问答来源丢失");
      childContexts.get(taskB).toolCallRound("child-approval", "write_file", {
        path: "queue-approved.txt",
        content: "仅批准后写入",
      });
      const queued = await pendingCount(window, sessionId, 3);
      assert(
        queued[2].request.kind === "approval" &&
          queued[2].request.source.task === taskB,
        "第三项必须为另一子代理的审批"
      );
      assert(
        new Set(queued.map((record) => record.request.id)).size === 3,
        "并发请求 ID 不可冲突"
      );
      await window
        .getByTestId("interaction-count")
        .filter({ hasText: "3" })
        .waitFor();
      await expectFront(window, queued[0], "主代理");
      await session.getByText("等待用户").waitFor();
      // 后台完整现场包含主/子代理全部请求；切到草稿不会取消任何等待。
      await window.getByTestId("new-session").click();
      await session.click();
      await expectFront(window, queued[0], "主代理");
      await pendingCount(window, sessionId, 3);
      assert(
        (await window.getByTestId("subagent-card").count()) === 2,
        "切回恢复两张子代理卡"
      );
      assert(
        !existsSync(join(homeDir, "workspace", "queue-approved.txt")),
        "排队审批前不能写文件"
      );
      // 主代理依然卡在自己的问答时，两个子代理请求已经在 UI 中可见，不能等 pump 才刷新。
      await window
        .getByTestId("interaction-history")
        .filter({ hasText: taskA })
        .waitFor();
      await window
        .getByTestId("interaction-history")
        .filter({ hasText: taskB })
        .waitFor();
      await assertReadOnlyHistory(window);
      const screenshotDir = mkdtempSync(
        join(tmpdir(), "codexlike-interaction-queue-")
      );
      await window.screenshot({
        path: join(screenshotDir, "concurrent-fifo.png"),
      });
      console.log(`[e2e:interactions] 并发截图目录 ${screenshotDir}`);

      await window.getByTestId("question-option-continue").check();
      await window.getByTestId("question-submit").click();
      await pendingCount(window, sessionId, 2);
      await expectFront(window, queued[1], taskA);
      await window
        .getByTestId("interaction-count")
        .filter({ hasText: "2" })
        .waitFor();
      await window.getByTestId("question-option-adjust").check();
      await window.getByTestId("question-submit").click();
      await pendingCount(window, sessionId, 1);
      await expectFront(window, queued[2], taskB);
      const approve = window
        .getByTestId("interaction-panel")
        .getByTestId("approval-approve");
      assert(
        (await approve.textContent()) === "批准本次",
        "审批批准按钮文案不正确"
      );
      await approve.click();
      await waitText(window, "并发问答审批全部完成");
      await pendingCount(window, sessionId, 0);
      assert(
        existsSync(join(homeDir, "workspace", "queue-approved.txt")),
        "批准后子代理文件未真正写入"
      );
      const childBody = seenBodies.find(
        (body) => toolResult(body, "child-question") !== undefined
      );
      const mainBody = seenBodies.find(
        (body) => toolResult(body, "main-question") !== undefined
      );
      assert(
        childBody !== undefined && mainBody !== undefined,
        "主/子代理未收到各自工具结果"
      );
      assert(
        JSON.parse(toolResult(childBody, "child-question")).answers[0]
          .selectedOptionIds[0] === "adjust",
        "子代理回答路由错误"
      );
      assert(
        JSON.parse(toolResult(mainBody, "main-question")).answers[0]
          .selectedOptionIds[0] === "continue",
        "主代理回答路由错误"
      );
      assert(
        mainBody.includes(`${taskA}完成报告`) &&
          mainBody.includes(`${taskB}完成报告`),
        "两个子代理的报告未回流主模型"
      );
      await assertReadOnlyHistory(window);
    }
  );
}

async function cancellationScenario() {
  await withScenario(
    "cancel",
    (ctx, { body }) => {
      const prompt = String(lastUserText(body));
      const approval = prompt.includes("审批");
      const callId = `cancel-${prompt}`;
      if (toolResult(body, callId) !== undefined)
        return ctx.textRound("取消后不应再调用模型");
      if (approval)
        ctx.toolCallRound(callId, "write_file", {
          path: `${prompt}.txt`,
          content: "不应落盘",
        });
      else ask(ctx, callId);
    },
    async ({ window, homeDir, seenBodies, launch, close }) => {
      await prepareDraft(window);
      const session = window
        .getByTestId("session-item")
        .filter({ hasText: "停止问答" });
      let sessionId;
      await window.getByTestId("approval-mode-select").selectOption("ask");
      const cancelledIds = [];
      for (const [prompt, restart] of [
        ["停止问答", false],
        ["停止审批", false],
        ["关闭问答", true],
        ["关闭审批", true],
      ]) {
        await send(window, prompt);
        await window
          .getByTestId("interaction-panel")
          .waitFor({ timeout: 20_000 });
        sessionId ??= await session.getAttribute("data-session-id");
        const pending = await pendingCount(window, sessionId, 1);
        const record = pending[0];
        cancelledIds.push(record.request.id);
        const requestsBefore = seenBodies.length;
        if (restart) {
          // 不先点击停止：退出应用后恢复的未完成交互也必须是取消态。
          await close();
          const next = await launch();
          window = next.window;
          await window
            .getByTestId("session-item")
            .filter({ hasText: "停止问答" })
            .click();
        } else {
          await window
            .getByTestId("interaction-panel")
            .getByTestId("composer-stop")
            .click();
        }
        await window.getByTestId("composer-send").waitFor();
        await pendingCount(window, sessionId, 0);
        await window
          .getByTestId("interaction-panel")
          .waitFor({ state: "hidden" });
        for (const id of cancelledIds) {
          const history = window
            .getByTestId("interaction-history")
            .filter({ hasText: "已取消" });
          await history.first().waitFor();
          const states = await window
            .getByTestId("interaction-history")
            .evaluateAll((nodes) =>
              nodes.map((node) => ({
                id: node.dataset.interactionId,
                status: node.dataset.interactionStatus,
              }))
            );
          assert(
            states.some(
              (state) => state.id === id && state.status === "cancelled"
            ),
            `历史交互未保留取消态 ${id}`
          );
        }
        await assertReadOnlyHistory(window);
        const response =
          record.request.kind === "approval"
            ? { kind: "approval", decision: "approve" }
            : {
                kind: "questions",
                answers: [
                  {
                    questionId: "choice",
                    status: "answered",
                    selectedOptionIds: ["continue"],
                    text: "",
                  },
                ],
              };
        const accepted = await window.evaluate(
          ({ sessionId, requestId, response }) =>
            window.codexlike.sessions.respondInteraction(
              sessionId,
              requestId,
              response
            ),
          { sessionId, requestId: record.request.id, response }
        );
        assert(
          accepted === false,
          "取消/重启后的陈旧响应不能重新授权或唤醒工具"
        );
        const states = await window.evaluate(() =>
          window.codexlike.sessions.list()
        );
        assert(
          states.find((state) => state.id === sessionId).status !==
            "waiting-user",
          "取消后会话不应仍显示等待用户"
        );
        assert(
          seenBodies.length === requestsBefore,
          "停止或关闭后不应继续请求模型"
        );
        assert(
          !existsSync(join(homeDir, "workspace", `${prompt}.txt`)),
          "取消的审批不能执行文件写入"
        );
      }
    }
  );
}

const cases = {
  questions: questionsScenario,
  queue: queueScenario,
  cancel: cancellationScenario,
};
const selected = process.env.CODEXLIKE_E2E_INTERACTION_CASE;
try {
  assert(selected === undefined || selected in cases, `未知场景 ${selected}`);
  for (const [name, run] of Object.entries(cases)) {
    if (selected === undefined || selected === name) await run();
  }
  console.log("[e2e:interactions] 所选场景全部通过");
} catch (error) {
  console.error("[e2e:interactions] 失败", error);
  process.exitCode = 1;
}
