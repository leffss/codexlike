// E2E 探针（票 01，goal-mode）：stub provider「工作轮 / 完成判定」两条脚本化
// 响应线互不串线的预构证明。目标模式本体尚未落地（票 02/03 实现），判定请求
// 暂由测试进程按票 02 对接契约（无工具 + [goal-verification] 标记）直接 POST
// 同一 mock server 模拟；工作轮请求由真实应用经真实 UI 发起。断言：
// - 工作轮按工作脚本序应答（UI 可见回复内容），判定请求不消耗其 index；
// - 判定线按判定脚本序应答 {passed, reason, nextAction}，raw / code-fence
//   两种容错形态 × 非流式 / 流式两种路径各自正确；
// - 两线脚本越界哨兵均未触发（任一串线都会让对侧收到哨兵内容而失败）。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:goal-stub（先全仓 build）。
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  assert,
  closeApp,
  createMockProfile,
  launchApp,
  prepareDraft,
} from "./helpers.mjs";
import {
  GOAL_VERIFICATION_MARKER,
  startGoalMockProvider,
} from "./goal-stub.mjs";

/** 发送一条消息并等待指定回复文本出现在最后一条助手消息（回合收尾信号） */
async function sendAndAwait(window, text, reply) {
  await window.getByTestId("composer-input").fill(text);
  await window.getByTestId("composer-send").click();
  await window
    .getByTestId("message-assistant")
    .last()
    .getByText(reply, { exact: true })
    .waitFor({ timeout: 20_000 });
}

/** 模拟票 02 完成判定请求：无工具 + 判定 prompt 标记（目标文本 + 消息历史） */
function verdictBody(stream) {
  return JSON.stringify({
    model: "mock-model",
    stream,
    messages: [
      {
        role: "system",
        content: `${GOAL_VERIFICATION_MARKER} 你是完成判定评估器：依据目标文本与完整消息历史，仅输出 {passed, reason, nextAction} JSON。`,
      },
      {
        role: "user",
        content: "目标：让示例测试全部通过。判定当前是否已完成。",
      },
    ],
  });
}

async function postVerdict(port, stream) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: verdictBody(stream),
  });
  assert(response.status === 200, "判定请求必须 200 应答");
  const raw = await response.text();
  return stream ? raw : JSON.parse(raw);
}

/** 解析 SSE 流式响应拼接 delta.content（验证帧格式合法可回放） */
function sseContent(raw) {
  let content = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length);
    if (payload === "[DONE]") continue;
    const delta = JSON.parse(payload).choices[0].delta;
    if (typeof delta?.content === "string") content += delta.content;
  }
  return content;
}

async function main() {
  const verdictVerdicts = [
    { passed: false, reason: "尚有步骤未完成", nextAction: "继续实现剩余步骤" },
    { passed: true, reason: "全部测试通过", nextAction: "无" },
  ];
  const { server, port, seenBodies, requestCount } =
    await startGoalMockProvider({
      // 工作轮脚本：两条真实回复 + 越界哨兵——若判定请求串了工作轮 index，
      // 第二条用户消息将收到哨兵文本而非「第 2 次回复」，断言失败。
      work(ctx, { index }) {
        if (index === 1) ctx.textRound("工作轮第 1 次回复");
        else if (index === 2) ctx.textRound("工作轮第 2 次回复");
        else ctx.textRound("工作轮脚本越界哨兵");
      },
      // 判定脚本：raw（非流式路径）→ code-fence（流式路径），第三条起哨兵。
      verdict(ctx, { index }) {
        if (index <= 2)
          ctx.verdictRound(
            verdictVerdicts[index - 1],
            index === 1 ? "raw" : "code-fence"
          );
        else
          ctx.verdictRound(
            { passed: false, reason: "判定线越界哨兵", nextAction: "无" },
            "string-wrapped"
          );
      },
    });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-goal-stub-"));
  mkdirSync(join(homeDir, "workspace"));

  let app;
  try {
    const launched = await launchApp({ homeDir });
    app = launched.app;
    const window = launched.window;
    await createMockProfile(window, { name: "Mock", port });
    await prepareDraft(window);

    // 1) 工作轮第 1 次：真实应用发起（streamText 带 tools），UI 断言脚本化回复
    await sendAndAwait(window, "开始第一个任务", "工作轮第 1 次回复");
    console.log("[e2e] 工作轮第 1 次：应用真实请求按工作脚本 index 1 应答");

    // 2) 判定线两次（模拟票 02 判定调用打到同一 server）：
    //    非流式 raw → JSON content；流式 code-fence → SSE 帧回放
    const first = await postVerdict(port, false);
    assert(
      first.choices[0].message.content === JSON.stringify(verdictVerdicts[0]) &&
        JSON.parse(first.choices[0].message.content).passed === false,
      "非流式判定应答必须是脚本化 raw verdict JSON"
    );
    const streamed = sseContent(await postVerdict(port, true));
    assert(
      streamed.startsWith("```json") &&
        JSON.parse(streamed.replace(/^```json\n/, "").replace(/\n```$/, ""))
          .passed === true,
      "流式判定应答必须是脚本化 code-fence verdict 文本"
    );
    console.log(
      "[e2e] 判定线两次：raw/非流式与 code-fence/流式均按判定脚本独立应答"
    );

    // 3) 工作轮第 2 次：关键断言——两个判定请求没有消耗工作轮 index
    //    （串线时此处将收到「第 1 次回复」重放或越界哨兵）
    await sendAndAwait(window, "继续第二个任务", "工作轮第 2 次回复");
    console.log("[e2e] 工作轮第 2 次：判定请求未串工作轮 index，脚本序保持");

    // 4) 账目核对：2 工作轮 + 2 判定 = 4 个请求，全部落 seenBodies 可取证
    assert(requestCount() === 4, `请求数应为 4，实际 ${requestCount()}`);
    assert(seenBodies.length === 4, "seenBodies 必须完整记录含判定请求");
    assert(
      seenBodies[1].includes(GOAL_VERIFICATION_MARKER) &&
        seenBodies[2].includes(GOAL_VERIFICATION_MARKER),
      "判定请求体必须含判定标记（票 02 对接契约）"
    );
    console.log("[e2e] 账目核对：4 请求两线分账，判定请求体含标记可取证");

    await closeApp(app);
    console.log("[e2e] goal-stub 探针通过 ✅");
  } catch (error) {
    console.error("[e2e] goal-stub 探针失败 ❌", error);
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
