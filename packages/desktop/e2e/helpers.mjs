// E2E 共享工具（code review 修复 5 抽取）：断言、应用关闭（含强杀兜底）、
// OpenAI 兼容 mock 骨架与应用启动。各 E2E 脚本只保留自己的场景逻辑
// （按请求序号/请求体特征脚本化的回复、UI 操作与断言）。
import http from "node:http";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { join, resolve } from "node:path";
import process from "node:process";

import { electron, launchTarget } from "./launch-target.mjs";

/** 极简断言 */
export function assert(condition, message) {
  if (!condition) {
    throw new Error(`断言失败：${message}`);
  }
}

/**
 * 票04 窗口底线后的窄窗基线（审查修复 4 归一处，六场景共用）：底线
 * minWidth=1000 之后，640/900 已缩不到、1000 压在底线上——minWidth 夹紧
 * 与 DPI 取整下 innerWidth 的精确断言（=== width）与上限断言（<= width）
 * 不再成立。窄窗用例统一抬到 1100（线外），按场景配合各自的窄窗高度。
 */
export const NARROW_WIDTH = 1100;

/**
 * 模型选择器复合键（票 02，ADR 0024 二元组；review 修复 5 收敛）：
 * 与 ui 侧 model-options 的 `${profileId}::${model}` 编码同构——e2e 是
 * 独立 .mjs，不跨包导入 ui 内部常量，此处是 e2e 侧唯一拼接来源，
 * 场景不再手写 `::` 复合键字面量（含 `${testId}-option-` 定位的原始值）。
 */
export const MODEL_VALUE_SEPARATOR = "::";

/** (profileId, 模型名) → 选择器/选项 value */
export function modelOptionValue(profileId, model) {
  return `${profileId}${MODEL_VALUE_SEPARATOR}${model}`;
}

/**
 * 工作区路径（桌面双卡 A）：消息卡首行直接显示当前任务的完整工作区路径，
 * 原标题栏工作区徽章弹层已退役。来源目录（Worktree 来源）不再单列展示，
 * 由首行的 Worktree 徽章表达「本工作区是托管副本」。
 */
export async function workspacePathInfo(window) {
  return {
    path: await window.getByTestId("workspace-topbar-path").textContent(),
  };
}

/** 逻辑字段沿用旧调用名；真实模型/思考控件只暴露统一 trigger，不保留隐藏旧 DOM。 */
export async function composerOptionValue(window, testId) {
  if (testId === "profile-select")
    return window
      .getByTestId("model-thinking-select")
      .getAttribute("data-model-value");
  if (testId === "thinking-effort-select")
    return window
      .getByTestId("model-thinking-select")
      .getAttribute("data-thinking-effort");
  return window.getByTestId(testId).getAttribute("data-value");
}

/** 真实打开选择器并操作选项；返回时关闭菜单，不绕过用户交互或风险确认。 */
export async function selectComposerOption(window, testId, value) {
  if (testId === "profile-select" || testId === "thinking-effort-select") {
    await window.getByTestId("model-thinking-select").click();
    const menu = window.getByTestId("model-thinking-popover");
    await menu.waitFor();
    if (testId === "profile-select") {
      const separator = value.indexOf(MODEL_VALUE_SEPARATOR);
      assert(separator > 0, "模型选项必须是 (Profile, 模型) 复合值");
      await menu
        .getByTestId("model-thinking-provider")
        .selectOption(value.slice(0, separator));
      await menu.getByTestId(`model-thinking-model-option-${value}`).click();
    } else {
      await menu.getByTestId(`model-thinking-effort-${value}`).click();
    }
    await window.waitForFunction(
      ({ attribute, value }) =>
        document
          .querySelector('[data-testid="model-thinking-select"]')
          ?.getAttribute(attribute) === value,
      {
        attribute:
          testId === "profile-select"
            ? "data-model-value"
            : "data-thinking-effort",
        value,
      }
    );
    // 模型点击即时保存但保持打开；通用 helper 仍保证调用方拿回已关闭的菜单。
    // 专用 thinking 场景必须直接验证保持打开，不能用此收尾掩盖契约。
    if (testId === "profile-select") await window.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    return;
  }
  const trigger = window.getByTestId(testId);
  await trigger.click();
  const menu = window.getByTestId(`${testId}-listbox`);
  await menu.waitFor();
  await menu.getByTestId(`${testId}-option-${value}`).click();
  await menu.waitFor({ state: "hidden" });
}

/** 操作指定行的 portal 菜单；右键不应隐式切换当前任务。 */
export async function taskMenu(window, item) {
  const id = await item.getAttribute("data-task-id");
  assert(id, "菜单目标必须有稳定任务 ID");
  await item.click({ button: "right" });
  const menu = window.getByTestId("task-context-menu");
  await menu.waitFor();
  assert((await menu.getAttribute("data-task-id")) === id, "菜单绑定目标 ID");
  return menu;
}

/**
 * 强制悬浮生效：Chromium 对静止鼠标 + 侧栏持续重渲染（IPC 事件流）下的
 * :hover 重算不确定，且 Playwright 的 click/hover 重试不重发 mousemove——
 * :hover 一旦失效，悬浮操作永远显示不出（实测被 project-task-count
 * 持续拦截 30s 超时）。先位移再归位，用两次 mousemove 强制浏览器重算。
 */
export async function hoverFor(window, locator) {
  const box = await locator.boundingBox();
  assert(box, "悬浮目标不可见");
  await window.mouse.move(box.x - 6, box.y + box.height / 2);
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/** 元素中心点当前是否真实命中自身或子孙（悬浮显隐已生效的确定信号）。 */
export function hitAtCenter(node) {
  const rect = node.getBoundingClientRect();
  const hit = document.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2
  );
  return hit === node || node.contains(hit);
}

/**
 * 草稿载入走异步 workbench 读取：切换/重启后立即断言输入框文本会与载入
 * 赛跑。等待到达期望文本（确定信号），而非立即断言。
 */
export async function untilDraft(window, expected, message) {
  const deadline = Date.now() + 5000;
  for (;;) {
    if ((await window.getByTestId("composer-input").inputValue()) === expected)
      return;
    assert(Date.now() < deadline, message);
    await delay(50);
  }
}

/**
 * 悬浮依赖型按钮的确定点击：强制 :hover 重算 → 轮询按钮真实可命中 →
 * 立即坐标点击。全程不给"重渲染干掉 :hover + 默认态元素持续拦截"留窗口。
 */
export async function hoverClick(window, locator, message = "悬浮按钮") {
  const deadline = Date.now() + 5000;
  while (!(await locator.evaluate(hitAtCenter))) {
    assert(Date.now() < deadline, `${message} 未在预期内可命中`);
    await hoverFor(window, locator);
    await delay(50);
  }
  const box = await locator.boundingBox();
  assert(box, `${message} 无可点击位置`);
  await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * 先悬浮指定项目头，再点击显现的操作，不以 force 绕过命中检查。
 */
export async function projectAction(
  window,
  action = "project-new-task",
  header = window.getByTestId("project-header")
) {
  await hoverClick(window, header.getByTestId(action), `悬浮操作 ${action}`);
}

/**
 * 项目组头右键打开菜单并点击指定菜单项（移除项目收进右键菜单，
 * 悬停 × 已取消）；菜单为 portal 渲染，按 aria-label 校验归属。
 */
export async function projectMenuAction(
  window,
  action,
  header = window.getByTestId("project-header")
) {
  await header.click({ button: "right" });
  const menu = window.getByTestId("task-context-menu");
  await menu.waitFor();
  assert(
    (await menu.getAttribute("aria-label")) === "项目操作",
    "菜单必须是项目操作"
  );
  await menu.getByTestId(action).click();
}

/**
 * 打开检视右栏（ADR 0018）并切到指定 tab：标题栏「右栏开关」唯一开合
 * 入口（幂等——已展开不再点），tab 切换走右栏自带描边按钮。
 */
const RAIL_PANEL_TESTIDS = {
  changes: "changes-panel",
  resources: "resources-panel",
  subagents: "subagents-panel",
};

export async function openRailPanel(window, tab = "changes") {
  const toggle = window.getByTestId("resources-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await window.getByTestId(`rail-tab-${tab}`).click();
  await window
    .getByTestId(RAIL_PANEL_TESTIDS[tab] ?? "changes-panel")
    .waitFor();
}

/**
 * 打开右栏「子代理」tab 并定位（ADR 0020；拆页导航 ADR 0032）：点击
 * 消息流标记行一步到位（开右栏 + 切 tab + 直跳对应子代理的详情页——
 * 标记行 focus 直跳不落列表页；子代理 id 运行时生成，标记行与列表项
 * 一一对应，点哪行定位哪个）。返回面板体 locator（报告与操作行断言
 * 的容器）。列表级行断言需先点 subagent-rail-back 返回列表页。
 */
export async function openSubagentDetail(window) {
  await window.getByTestId("subagent-stream-marker-toggle").first().click();
  await window.getByTestId("subagents-panel-body").waitFor();
  return window.getByTestId("subagents-panel-body");
}

/** 关闭检视右栏（幂等——已关闭不再点）。 */
export async function closeRailPanel(window) {
  const toggle = window.getByTestId("resources-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "true") {
    await toggle.click();
  }
  await window.getByTestId("rail-panel").waitFor({ state: "hidden" });
}

/**
 * 折叠卡内距契约（2026-11-26 用户反馈：已回答/已思考卡片的标题与展开体
 * 缩进和 write_file 等工具卡不一致）。工具卡基准：卡壳不挂水平内距，
 * 摘要标题文字左缘 = 卡壳 + 26px（px-3.5 箭头 + gap-2），展开体正文左缘 =
 * 卡壳 + 28px（pl-7），分隔线通栏。卡壳挂 px 会让展开体叠加成 42px，
 * 漏掉 pl-7 则停在 14px——两种历史错位都由本断言锁住。
 *
 * 标题按「文字」左缘而非元素盒测：工具卡标题是带内距的 name 徽章，
 * 盒左缘 26px 时文字被 px 推到 32px——2026-11-27 用户反馈 apply_patch
 * 卡片标题文字比「已思考」多缩进 6px 即此（盒对齐、字未对齐）。
 * 徽章用 -ml 抵消自身左内距后，文字与纯文本标题同落 26px。
 *
 * title / body 传 Locator（由调用方用 getByTestId 在 card 上取）：
 * 与 e2e 定位收口一致，不在这里拼选择器字符串。
 * body 省略时只校验标题（工具组组头等单行行族共用 26px 标题契约）。
 */
export async function assertCollapseInsets(card, label, { title, body }) {
  const cardBox = await card.boundingBox();
  const titleTextLeft = await title.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    // 与原来的 titleBox 守卫同口径：不可见标题不参与几何断言
    if (rect.width === 0 && rect.height === 0) return null;
    return rect.left + parseFloat(window.getComputedStyle(node).paddingLeft);
  });
  assert(
    cardBox !== null && titleTextLeft !== null,
    `${label}：卡壳或摘要标题不可见`
  );
  const titleInset = titleTextLeft - cardBox.x;
  assert(
    Math.abs(titleInset - 26) <= 1,
    `${label}：摘要标题文字左缘应为卡壳 + 26px，实际 ${titleInset.toFixed(2)}px`
  );
  if (body === undefined) return;
  const bodyBox = await body.evaluate((node) => {
    // 展开体的正文区 = 边框盒减去左右内距（卡壳内距已下沉到展开体）
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return {
      left: rect.left + parseFloat(style.paddingLeft),
      right: rect.right - parseFloat(style.paddingRight),
      width: rect.width,
    };
  });
  const bodyLeftInset = bodyBox.left - cardBox.x;
  const bodyRightInset = cardBox.x + cardBox.width - bodyBox.right;
  assert(
    Math.abs(bodyLeftInset - 28) <= 1,
    `${label}：展开体正文左缘应为卡壳 + 28px，实际 ${bodyLeftInset.toFixed(2)}px`
  );
  assert(
    Math.abs(bodyRightInset - 12) <= 1,
    `${label}：展开体右缘应为卡壳 - 12px，实际 ${bodyRightInset.toFixed(2)}px`
  );
  assert(
    Math.abs(bodyBox.width - cardBox.width) <= 1,
    `${label}：展开体分隔线应通栏（展开体宽 ${bodyBox.width.toFixed(2)}，卡壳宽 ${cardBox.width.toFixed(2)}）`
  );
}

/** 真实渲染遮罩应采用主题定义的overlay颜色，而不是组件硬编码色阶。 */
export async function assertSemanticOverlay(dialog) {
  const colors = await dialog.evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--overlay)";
    document.body.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      actual: getComputedStyle(element.parentElement).backgroundColor,
      expected,
    };
  });
  assert(
    colors.actual === colors.expected,
    `遮罩必须遵循主题overlay：${JSON.stringify(colors)}`
  );
}

/** 正常退出走票08确认/保存屏障；兜底只清理本次启动的进程树，不能误杀其他任务。 */
export async function closeApp(app) {
  if (!app) return;
  const child = app.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  let exited = false;
  const done = new Promise((resolve) =>
    child.once("exit", () => {
      exited = true;
      resolve();
    })
  );
  try {
    await app.evaluate(({ app }) => {
      app.quit();
    });
    const deadline = Date.now() + 10_000;
    while (!exited && Date.now() < deadline) {
      const window = app.windows()[0];
      if (window) {
        const confirm = window.getByTestId("exit-confirm");
        if (await confirm.isVisible().catch(() => false))
          await confirm.click({ timeout: 1000 }).catch(() => {});
      }
      await Promise.race([done, delay(50)]);
    }
  } finally {
    if (!exited) {
      console.warn(`[e2e] 正常退出未完成，仅清理本测试进程树 PID=${child.pid}`);
      if (process.platform === "win32") {
        await new Promise((resolve) =>
          execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], resolve)
        );
      } else child.kill("SIGKILL");
      await Promise.race([done, delay(5000)]);
      assert(exited, `测试进程 ${child.pid} 未清理，不能删除其数据目录`);
    }
  }
}

/** 首次配置经真实设置页完成，避免后台 IPC 写入与工作台初次读取竞态。 */
export async function createMockProfile(window, { name, port }) {
  await window.getByTestId("settings-open").click();
  await window.getByTestId("profile-create").click();
  const form = window.locator("form");
  await form.getByLabel("名称").fill(name);
  await form.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
  await form.getByLabel("API Key").fill("sk-e2e");
  await form.getByLabel("模型 1").fill("mock-model");
  await form.getByRole("button", { name: /保存|创建/ }).click();
  await window.getByText(name, { exact: true }).waitFor();
  await window.getByTestId("settings-back").click();
}

/** 仅准备新草稿；不预造空任务，也不发送额外模型请求。权限必须由场景显式选择。 */
export async function prepareDraft(
  window,
  { project = false, worktree = false, approvalMode = "ask" } = {}
) {
  // 冷启动侧栏列表尚在异步加载，使用公开宿主列表计数避免把恢复记录误判成新建。
  const before = await window.evaluate(
    async () => (await window.codexlike.tasks.list()).length
  );
  if (project) {
    if ((await window.getByTestId("project-group").count()) === 0) {
      await window.getByTestId("add-project").click();
      await window.getByTestId("project-group").waitFor();
    }
    await projectAction(window);
  } else {
    // 顶栏「+」单按钮直达独立入口草稿（票03：菜单退役，单击一步开草稿）
    await window.getByTestId("new-task").click();
    await window.getByTestId("draft-select-workspace").click();
  }
  if (worktree)
    await window.getByTestId("draft-workspace-mode").selectOption("worktree");
  assert(
    (await window.evaluate(
      async () => (await window.codexlike.tasks.list()).length
    )) === before,
    "首次发送前不能增加空历史"
  );
  assert(
    (await window
      .getByTestId("approval-mode-select")
      .getAttribute("data-value")) === "ask",
    "新任务从 ask 开始"
  );
  if (approvalMode !== "ask")
    await selectComposerOption(window, "approval-mode-select", approvalMode);
}

/** OpenAI 兼容 SSE 单帧（chat.completion.chunk 包装）；extra 展开到 chunk 顶层（如 usage） */
function sseChunk(payload, extra = {}) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock-model",
    choices: [{ index: 0, ...payload }],
    ...extra,
  })}\n\n`;
}

/**
 * 一次模型调用应答携带的真实 usage（goal-mode 票 05：token 预算对账需要
 * 确定性的用量）。{ promptTokens, completionTokens }。
 */

/** usage 的 OpenAI 兼容协议形状；未给出时不带 usage 字段（既有场景的应答逐字节不变） */
function usageChunk(usage) {
  if (usage === undefined) return {};
  return {
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.promptTokens + usage.completionTokens,
    },
  };
}

/**
 * /chat/completions 请求的应答工具集（骨架提供给脚本 onChat 的 ctx）：
 * - send/finishWith：SSE 帧（writeHead 惰性，脚本仍可改走 respondJson/notFound）
 * - toolCallRound/textRound：工具调用轮 / 文本轮（30ms 后收尾帧，模拟两段式流）
 * - textChunksRound：多段慢速流（客户端断开时停止）
 * - respondJson：非流式 JSON（generateText 路径，如提交消息生成）
 * - notFound：404；port：本 server 端口（构造回环 URL 用）
 * 各收尾类方法可带 usage：随收尾帧上报（流式协议里 usage 在 chunk 顶层，
 * SDK 取流中任一帧携带的 usage），任务用量据此入账。
 */
function createChatContext(res, port) {
  const send = (payload, usage) => {
    if (!res.headersSent) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
    }
    res.write(sseChunk(payload, usageChunk(usage)));
  };
  const finishWith = (reason, usage) => {
    send({ delta: {}, finish_reason: reason }, usage);
    res.write("data: [DONE]\n\n");
    res.end();
  };
  return {
    res,
    port,
    send,
    finishWith,
    toolCallRound(callId, name, args, usage) {
      send({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: callId,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: null,
      });
      setTimeout(() => finishWith("tool_calls", usage), 30);
    },
    textRound(text, usage) {
      send({ delta: { content: text }, finish_reason: null });
      setTimeout(() => finishWith("stop", usage), 30);
    },
    textChunksRound(chunks, interval = 30, usage) {
      let index = 0;
      const timer = setInterval(() => {
        try {
          if (index < chunks.length) {
            send({ delta: { content: chunks[index++] }, finish_reason: null });
            return;
          }
          clearInterval(timer);
          finishWith("stop", usage);
        } catch {
          clearInterval(timer);
        }
      }, interval);
      // 客户端中断（abort）后停止发送
      res.on("close", () => clearInterval(timer));
    },
    respondJson(payload) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    },
    notFound() {
      if (!res.headersSent) {
        res.writeHead(404);
        res.end("not found");
      }
    },
  };
}

/**
 * WHATWG fetch bad port 列表（undici 与 Chromium 一致拒绝访问，报
 * "fetch failed, cause: bad port"）。本机 TCP 动态端口范围若覆盖其中端口
 * （6666/10080 等），listen(0) 会偶发分配到：单跑命中概率低，全量链上
 * 累计启动几十个 mock 必撞——撞上就换端口重听。
 */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080,
]);

/** listen(0) 分配安全端口：撞 bad port 就关闭重听。 */
async function listenSafePort(server) {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    if (!BAD_PORTS.has(port)) return port;
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * 本地 OpenAI 兼容 mock 骨架：
 * - POST …/chat/completions → 收集请求体后交给 onChat(ctx)，ctx 含应答工具集与
 *   { body, index（第几个工作轮请求，从 1 起）, port }；onChat 必须自行应答（工具/文本/JSON/404）。
 * - 其余 method/path 交给 onOther(req, res)，返回 true 表示已处理，否则骨架回 404。
 * - options（票 01 goal-mode）：{ isVerdictRequest?, onVerdict? }——请求体命中
 *   isVerdictRequest 时改走判定线 onVerdict(ctx, { body, index（判定线独立计数，从 1 起）, port })，
 *   不进入 onChat、不消耗工作轮 index（两条脚本化响应线互不串线）；
 *   ctx 额外携带 verdictRound（按 body.stream 自适应 SSE/JSON 应答完成判定结论）。
 *   不传 options 时行为与旧签名完全一致（无判定线，index 即全局请求序）。
 * 返回 { server, port, seenBodies（含判定请求体）, requestCount()（全部 chat 请求数）}。
 */
export async function startMockProvider(onChat, onOther, options) {
  let requestCount = 0;
  let workCount = 0;
  let verdictCount = 0;
  const seenBodies = [];
  const server = http.createServer((req, res) => {
    if (
      req.method === "POST" &&
      req.url !== undefined &&
      req.url.endsWith("/chat/completions")
    ) {
      requestCount += 1;
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        seenBodies.push(body);
        const port = server.address().port;
        if (options !== undefined && options.isVerdictRequest?.(body)) {
          verdictCount += 1;
          // ctx 为原始应答工具集；判定线专用增强（verdictRound）由
          // goal-stub.mjs 的包装层注入，骨架不感知判定领域逻辑。
          options.onVerdict(createChatContext(res, port), {
            body,
            index: verdictCount,
            port,
          });
          return;
        }
        workCount += 1;
        onChat(createChatContext(res, port), {
          body,
          index: workCount,
        });
      });
      return;
    }
    if (onOther === undefined || onOther(req, res) !== true) {
      res.writeHead(404);
      res.end("not found");
    }
  });
  const port = await listenSafePort(server);
  return {
    server,
    port,
    seenBodies,
    requestCount: () => requestCount,
  };
}

/**
 * 启动真实 Electron 应用（生产产物）：
 * workspaceDir 缺省为 <homeDir>/workspace；extra env 合并覆盖（如 CODEXLIKE_TAVILY_URL）。
 * 主进程 stdout/stderr 与渲染进程 console.error 转打到测试日志（排障用）。
 */
export async function launchApp({ homeDir, workspaceDir, env }) {
  const fullEnv = {
    ...process.env,
    CODEXLIKE_HOME: homeDir,
    CODEXLIKE_TEST_AGENTS_HOME: join(homeDir, "compatible-agents"),
    CODEXLIKE_TEST_WORKSPACE: workspaceDir ?? join(homeDir, "workspace"),
    // 业务目录之外，Chromium 的缓存/localStorage 也必须与用户日常应用隔离。
    CODEXLIKE_TEST_USER_DATA: join(homeDir, "electron-user-data"),
    // 生产模式：不带 VITE_DEV_SERVER_URL，主进程以 file:// 加载 ui/dist
    VITE_DEV_SERVER_URL: "",
    // GUI 启动忠实度：资源管理器/开始菜单启动的应用没有 LANG/LC_*（Windows
    // 默认不设），从终端跑 e2e 会继承 shell locale——曾让「非登录 bash 无
    // LANG → readline C locale 逐字节计宽 → CJK 分支名提示符重绘叠印」在本
    // 机永远探不到（2026-11-22 根因轮）。这里显式剥离对齐用户环境；git-bash
    // 由托管 init 兜底 C.UTF-8。空串 = bash 侧 test -z 判空同未设置。
    LANG: "",
    LC_ALL: "",
    LC_CTYPE: "",
    LC_COLLATE: "",
    ...(env ?? {}),
  };
  const app = await electron.launch(launchTarget(fullEnv));
  app
    .process()
    .stdout?.on("data", (chunk) =>
      console.log(`[main] ${String(chunk).trimEnd()}`)
    );
  app
    .process()
    .stderr?.on("data", (chunk) =>
      console.error(`[main:err] ${String(chunk).trimEnd()}`)
    );
  const window = await app.firstWindow();
  try {
    const paths = await app.evaluate(({ app: runtime }) => ({
      userData: runtime.getPath("userData"),
      sessionData: runtime.getPath("sessionData"),
    }));
    const expected = resolve(fullEnv.CODEXLIKE_TEST_USER_DATA);
    assert(
      resolve(paths.userData) === expected &&
        resolve(paths.sessionData) === join(expected, "session"),
      "Electron 用户数据和会话数据必须使用本场景隔离目录"
    );
  } catch (error) {
    await closeApp(app).catch(() => {});
    throw error;
  }
  window.on("console", (message) => {
    if (message.type() === "error") {
      console.log(`[renderer console.error] ${message.text()}`);
    }
  });
  return { app, window };
}
