// E2E（ADR 0033 票 09）：终端会话用户侧主链路 + agent 侧链路。
// 路径：建 Profile → 建任务 → rail 第四 tab「终端」初始态（无会话）→ 新建
// 用户侧会话 → 详情页 xterm 手敲命令 → 输出可见（文本层行节点）→ kill →
// 详情页原位只读回看 →「已退出」组 → 用户侧标记行状态推进；同任务 agent
// 链路（ask 档审批逐次）：spawn_terminal（审批卡显示初始命令）→ 消息流标记行
// 点击直跳详情页（不落列表页：rail-tab 自动切 + back 存在 + 列表行不渲染）→
// terminal_read 增量可见 → terminal_read 用户侧已退出会话（read 边界=本任务内
// 任意来源/状态）→ terminal_kill（write 权限审批卡）→ 已退出 → 请求体验证
// 工具结果回填。
// 断言纪律：xterm 文本层（DOM renderer 行节点 textContent）+ testid 清单，
// 不碰 canvas 像素；输入注入走渲染端键盘事件 → xterm onData → IPC write，
// 不直碰 pty。会话名「git-bash · N」任务内序号天然唯一（06 票造数据纪律）。
// 输出断言用 $((算术)) 让输出数字不出现在键入命令原文里——区分「命令回显行」
// 与「真实输出行」，防止输入折行恰好把命令尾词折成独立行造成假阳。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:terminal（先 build）。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

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

const USER_TASK = "用户侧终端验证";
const AGENT_TASK = "委派终端链路";
// 输出值经 shell 算术展开：1042 / 7057——键入原文「echo $((1000+42))」不含
// 这些数字，行节点精确匹配到它们即证明命令真实执行（输入回显不可能命中）。
const USER_COMMAND = "echo $((1000+42))";
const USER_OUTPUT = "1042";
const AGENT_COMMAND = "echo $((7000+57))";
const AGENT_OUTPUT = "7057";
const AGENT_DONE = "agent 终端链路完成";
const SPAWN_CALL = "call-spawn-b";
const READ_AGENT_CALL = "call-read-b";
const READ_USER_CALL = "call-read-user";
const KILL_CALL = "call-kill-b";
const SESSION_ID_PATTERN =
  /sessionId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/** 只提取消息正文（subagents.mjs 同款）：工具结果可能是字符串或分段数组。 */
function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function toolResultText(request, callId) {
  const found = request.messages.find(
    (message) => message.role === "tool" && message.tool_call_id === callId
  );
  return found === undefined ? null : messageText(found);
}

/** 前缀匹配的最新工具结果（transcript 按时序排列，从尾扫即最新）。 */
function lastToolResultByPrefix(request, prefix) {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (
      message.role === "tool" &&
      typeof message.tool_call_id === "string" &&
      message.tool_call_id.startsWith(prefix)
    ) {
      return messageText(message);
    }
  }
  return null;
}

/**
 * 场景脚本（按请求序分流；轮次依赖工具结果回填，故先查 tool 结果再查
 * 用户文本——后续轮的 transcript 同时含首轮用户文本与工具结果）：
 * 首轮文本 → spawn（ask 审批）→ read agent 会话（wait 增量；shell 启动
 * 与命令执行有真实耗时，早读可能只回 conpty 初始转义序列——同阶段换新
 * call id 重读直到输出可见，即真实模型「读到再继续」的行为）→
 * read 用户侧已退出会话（任意来源/状态边界，缓冲已在、一次即得）→
 * kill（ask 审批）→ 收尾文本。
 */
async function main() {
  let agentSessionId = null;
  let userSessionId = null;
  let readAgentRetries = 0;
  const { server, port, seenBodies } = await startMockProvider(
    (ctx, { body }) => {
      const request = JSON.parse(body);
      const guard = (label) => {
        ctx.res.writeHead(500);
        ctx.res.end(`unexpected state: ${label}`);
      };
      if (toolResultText(request, KILL_CALL) !== null) {
        ctx.textRound(AGENT_DONE);
        return;
      }
      if (toolResultText(request, READ_USER_CALL) !== null) {
        if (agentSessionId === null) return guard("agentSessionId");
        ctx.toolCallRound(KILL_CALL, "terminal_kill", {
          sessionId: agentSessionId,
        });
        return;
      }
      const readAgentResult = lastToolResultByPrefix(request, READ_AGENT_CALL);
      if (readAgentResult !== null) {
        if (agentSessionId === null) return guard("agentSessionId");
        if (!readAgentResult.includes(AGENT_OUTPUT)) {
          readAgentRetries += 1;
          assert(readAgentRetries <= 20, "agent 会话读取重试超限");
          ctx.toolCallRound(
            `${READ_AGENT_CALL}-${readAgentRetries}`,
            "terminal_read",
            { sessionId: agentSessionId, wait: true, timeoutMs: 15000 }
          );
          return;
        }
        if (userSessionId === null) return guard("userSessionId");
        ctx.toolCallRound(READ_USER_CALL, "terminal_read", {
          sessionId: userSessionId,
          wait: true,
          timeoutMs: 15000,
        });
        return;
      }
      const spawnAck = toolResultText(request, SPAWN_CALL);
      if (spawnAck !== null) {
        const matched = spawnAck.match(SESSION_ID_PATTERN);
        if (matched === null) {
          ctx.res.writeHead(500);
          ctx.res.end(
            `spawn ack 原文: ${JSON.stringify(spawnAck).slice(0, 500)}`
          );
          return;
        }
        agentSessionId = matched[1];
        ctx.toolCallRound(READ_AGENT_CALL, "terminal_read", {
          sessionId: agentSessionId,
          wait: true,
          timeoutMs: 15000,
        });
        return;
      }
      const lastUser = request.messages
        .filter((message) => message.role === "user")
        .map(messageText)
        .join("\n");
      if (lastUser.includes(AGENT_TASK)) {
        ctx.toolCallRound(SPAWN_CALL, "spawn_terminal", {
          command: AGENT_COMMAND,
        });
        return;
      }
      if (lastUser.includes(USER_TASK)) {
        ctx.textRound("用户侧终端已就绪。");
        return;
      }
      ctx.res.writeHead(422);
      ctx.res.end("unexpected request");
    }
  );

  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-terminal-"));
  mkdirSync(join(homeDir, "workspace"), { recursive: true });

  let app;
  try {
    const launched = await launchApp({ homeDir });
    app = launched.app;
    const window = launched.window;
    await createMockProfile(window, { name: "Mock", port });

    // ===== 链路 a：用户侧主链路 =====
    await prepareDraft(window);
    await sendMessage(window, USER_TASK);
    await waitForIdle(window, "用户侧终端已就绪。");

    // rail 第四 tab 初始态（CODING_STANDARDS 会话初始态覆盖）：无会话文案
    await openTerminalRailTab(window);
    const panelBody = window.getByTestId("terminals-panel-body");
    assert(
      (await panelBody.textContent()).includes("本任务尚无终端会话"),
      "终端 tab 初始态应显示无会话文案"
    );

    // 新建用户侧会话：运行中组出现，富行含会话名与「用户」来源标
    await window.getByTestId("terminal-create").click();
    const firstItem = window
      .getByTestId("terminal-rail-item")
      .filter({ hasText: "git-bash · 1" });
    await firstItem.waitFor({ timeout: 15000 });
    assert(
      (await firstItem.textContent()).includes("用户"),
      "用户侧会话富行应标注「用户」来源"
    );

    // 消息流标记行（用户侧无动词，06 票断言面）
    const marker = window.getByTestId("terminal-stream-marker-toggle");
    await marker.waitFor({ timeout: 10000 });
    assert(
      (await marker.count()) === 1,
      "此时应只有一个终端标记行（用户侧会话）"
    );
    const markerText = await marker.textContent();
    assert(
      markerText.includes("终端会话 git-bash · 1") &&
        !markerText.includes("启动了"),
      `用户侧标记行应无动词摘要：${markerText}`
    );
    assert(
      (await marker.getAttribute("data-terminal-state")) === "running",
      "用户侧标记行初始 running"
    );

    // 详情页：顶栏 + xterm 手敲命令走真实输入路径（键盘 → onData → IPC write）
    await firstItem.click();
    await window.getByTestId("terminal-rail-detail-header").waitFor();
    assert(
      (await window.getByTestId("terminal-rail-title").textContent()) ===
        "git-bash · 1",
      "详情页标题应为会话名"
    );
    assert(
      (await window.getByTestId("terminal-rail-kill").count()) === 1,
      "running 会话详情页应有终止按钮"
    );
    await focusTerminal(window);
    await window.keyboard.type(USER_COMMAND);
    await window.keyboard.press("Enter");
    await xtermRowVisible(window, USER_OUTPUT);
    console.log("[e2e] 用户侧手敲命令输出可见（xterm 文本层）");

    // kill（用户 kill 不弹确认，ADR 0033）：详情页原位转只读回看，输出仍在
    await window.getByTestId("terminal-rail-kill").click();
    const header = window.getByTestId("terminal-rail-detail-header");
    await header
      .getByText("只读回看", { exact: true })
      .waitFor({ timeout: 15000 });
    assert(
      (await window.getByTestId("terminal-rail-kill").count()) === 0,
      "已退出会话详情页不应再有终止按钮"
    );
    await xtermRowVisible(window, USER_OUTPUT);
    assert(
      (await marker.getAttribute("data-terminal-state")) === "exited",
      "标记行应随 kill 事件推进 exited"
    );
    console.log("[e2e] 用户侧 kill → 原位只读回看，输出保留");

    // 返回列表页：「已退出」组出现（空组不渲染 → 此刻唯一组头）
    await window.getByTestId("terminal-rail-back").click();
    await firstItem.waitFor({ timeout: 10000 });
    const headers = window.getByTestId("terminal-rail-group-header");
    assert(
      (await headers.count()) === 1 &&
        (await headers.first().textContent()).includes("已退出"),
      "kill 后应只剩「已退出」分组"
    );
    assert(
      (await firstItem.getAttribute("data-terminal-state")) === "exited",
      "列表行应推进 exited"
    );

    // ===== 链路 b：agent 侧链路（同一任务，read 边界覆盖用户侧会话） =====
    // read 边界素材（05 票口径：本任务内任意来源/状态）：用户侧会话 id
    // 经公开 IPC listFor 取得（只读识别，不注入输入）
    const taskId = await window.evaluate(async (title) => {
      const records = await window.codexlike.tasks.list();
      const record = records.find((item) => item.title === title);
      return record ? record.id : null;
    }, USER_TASK);
    assert(taskId, "任务记录未找到");
    userSessionId = await window.evaluate(async (id) => {
      const sessions = await window.codexlike.terminals.listFor(id);
      const mine = sessions.find((item) => item.origin === "user");
      return mine ? mine.sessionId : null;
    }, taskId);
    assert(userSessionId, "用户侧会话未在 listFor 中返回");

    await sendMessage(window, AGENT_TASK);
    const panel = window.getByTestId("interaction-panel");
    await panel.waitFor({ timeout: 20000 });
    assert(
      (await panel.textContent()).includes(AGENT_COMMAND),
      "spawn 审批卡应显示初始命令原文"
    );
    await panel.getByTestId("approval-approve").click();

    // 标记行出现 → 点击直跳详情页（06 票断言面：不落列表页）
    const agentMarker = window.locator(
      '[data-testid="terminal-stream-marker-toggle"][data-terminal-state="running"]'
    );
    await agentMarker.waitFor({ timeout: 20000 });
    const agentMarkerText = await agentMarker.textContent();
    assert(
      agentMarkerText.includes("启动了终端会话 git-bash · 2"),
      `agent 标记行应有动词摘要：${agentMarkerText}`
    );
    await agentMarker.click();
    await window.getByTestId("terminal-rail-detail-header").waitFor();
    assert(
      (await window.getByTestId("terminal-rail-title").textContent()) ===
        "git-bash · 2",
      "直跳应落在 agent 会话详情页"
    );
    assert(
      (await window
        .getByTestId("rail-tab-terminals")
        .getAttribute("aria-selected")) === "true",
      "直跳应自动切到终端 tab"
    );
    assert(
      (await window.getByTestId("terminal-rail-back").count()) === 1,
      "直跳不落列表页锚一：返回按钮存在"
    );
    assert(
      (await window.getByTestId("terminal-rail-item").count()) === 0,
      "直跳不落列表页锚二：列表行不渲染"
    );
    // 详情页 xterm 文本层可见初始命令输出（subscribe buffered 回放）
    await xtermRowVisible(window, AGENT_OUTPUT);
    console.log("[e2e] agent spawn 审批放行 → 标记行直跳详情，输出可见");

    // kill 审批卡（terminal_kill write 权限，ask 档逐次审批）
    const killPanel = window.getByTestId("interaction-panel");
    await killPanel.waitFor({ timeout: 20000 });
    await killPanel.getByTestId("approval-approve").click();

    // 收尾文本到达（任务回 idle）+ 标记行与详情页推进 exited
    await waitForIdle(window, AGENT_DONE);
    assert(
      (await agentMarker.count()) === 0 &&
        (await window
          .locator(
            '[data-testid="terminal-stream-marker-toggle"][data-terminal-state="exited"]'
          )
          .count()) === 2,
      "kill 后两个标记行都应为 exited"
    );
    const detailHeader = window.getByTestId("terminal-rail-detail-header");
    assert(
      (await detailHeader.getByText("只读回看", { exact: true }).count()) === 1,
      "agent 会话详情页应原位转只读回看"
    );
    await window.getByTestId("terminal-rail-back").click();
    const exitedItems = window
      .getByTestId("terminal-rail-item")
      .filter({ hasText: "git-bash · " });
    assert(
      (await exitedItems.count()) === 2,
      "「已退出」组应有两个会话（用户侧 + agent 侧）"
    );
    console.log("[e2e] agent kill 审批放行 → 标记行/详情/列表推进 exited");

    // ===== 请求体验证：工具结果回填真实可见（模型侧链路证据） =====
    const requests = seenBodies.map((body) => JSON.parse(body));
    const withCall = (callId) =>
      requests.find((request) => toolResultText(request, callId) !== null);
    const spawnAckResult = toolResultText(withCall(SPAWN_CALL), SPAWN_CALL);
    assert(
      spawnAckResult !== null &&
        spawnAckResult.includes("sessionId=") &&
        spawnAckResult.includes("git-bash · 2") &&
        spawnAckResult.includes("初始命令已提交"),
      `spawn 工具结果未按契约回填：${spawnAckResult}`
    );
    const readAgentResult = lastToolResultByPrefix(
      { messages: requests.flatMap((request) => request.messages) },
      READ_AGENT_CALL
    );
    assert(
      readAgentResult !== null && readAgentResult.includes(AGENT_OUTPUT),
      `terminal_read 增量未含初始命令输出：${readAgentResult}`
    );
    const readUserResult = toolResultText(
      withCall(READ_USER_CALL),
      READ_USER_CALL
    );
    assert(
      readUserResult !== null &&
        readUserResult.includes(USER_OUTPUT) &&
        readUserResult.includes("会话已退出"),
      `read 边界（本任务内任意来源/状态）未验证：${readUserResult}`
    );
    const killResult = toolResultText(withCall(KILL_CALL), KILL_CALL);
    assert(
      killResult !== null && killResult.includes("已发送终止信号"),
      `terminal_kill 工具结果未按契约回填：${killResult}`
    );
    console.log("[e2e] 四工具结果回填请求体验证（spawn/read×2/kill）");

    await closeApp(app);
    app = null;
    console.log("[e2e] 终端会话用户侧 + agent 侧链路通过 ✅");
  } catch (error) {
    console.error("[e2e] 终端会话链路失败 ❌", error);
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
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

await main();
