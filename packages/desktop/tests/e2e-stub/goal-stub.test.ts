// 票 01（goal-mode）：e2e stub provider「判定回复」线的单测——真起
// startGoalMockProvider 的 HTTP server，用 fetch 打 OpenAI 兼容请求，
// 断言两条脚本化响应线（工作轮 / 完成判定）按请求特征分流、index 分账
// 互不串线。判定请求契约对齐 spec「完成判定」：无工具 + 判定 prompt 标记
// （目标文本 + 完整消息历史由票 02 落地，此处只锁识别特征与应答形态）。
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_VERIFICATION_MARKER,
  isGoalVerificationRequest,
  startGoalMockProvider,
  startMockProvider,
} from "../../e2e/goal-stub.mjs";

const handles: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

/** 工作轮请求体样本：streamText 路径——stream + 非空 tools（agent-task 先例） */
function workRoundBody(text: string, stream = true): string {
  return JSON.stringify({
    model: "mock-model",
    stream,
    ...(stream ? {} : {}),
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "读文件",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    messages: [{ role: "user", content: text }],
  });
}

/**
 * 完成判定请求体样本：无 tools + 判定 prompt 标记（spec 完成判定契约：
 * 任务当前模型、无工具、目标文本 + 完整消息历史）。stream 由调用方给。
 */
function verdictRoundBody(stream: boolean): string {
  return JSON.stringify({
    model: "mock-model",
    stream,
    messages: [
      {
        role: "system",
        content: `${GOAL_VERIFICATION_MARKER} 你是完成判定评估器：依据目标文本与完整消息历史，输出 {passed, reason, nextAction}。`,
      },
      { role: "user", content: "目标：让测试全部通过。判定当前是否已完成。" },
    ],
  });
}

async function postChat(
  port: number,
  body: string
): Promise<{ status: number; text: string; json: () => Promise<any> }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: () => Promise.resolve(JSON.parse(text)),
  };
}

/** 解析 SSE 流式响应，拼接全部 delta.content（验证帧格式合法可回放） */
function sseContent(raw: string): string {
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

/** 起一个双线 mock provider，记录两线各自收到的 index 序列 */
async function launchTwoLineStub() {
  const workIndexes: number[] = [];
  const verdictIndexes: number[] = [];
  const handle = await startGoalMockProvider({
    work(ctx, { index }) {
      workIndexes.push(index);
      ctx.textRound(`工作轮 ${index}`);
    },
    verdict(ctx, { index }) {
      verdictIndexes.push(index);
      ctx.verdictRound(
        index === 1
          ? { passed: false, reason: "尚有步骤未完成", nextAction: "继续实现" }
          : { passed: true, reason: "目标已达成", nextAction: "无" },
        "raw"
      );
    },
  });
  handles.push({ close: () => handle.server.close() });
  return { handle, workIndexes, verdictIndexes };
}

describe("isGoalVerificationRequest：完成判定请求识别特征", () => {
  it("无工具 + 判定标记 → 判定请求", () => {
    expect(isGoalVerificationRequest(verdictRoundBody(false))).toBe(true);
  });

  it("无工具 + 中文「完成判定」措辞（无英文标记）→ 仍识别为判定请求", () => {
    const body = JSON.stringify({
      model: "m",
      messages: [
        { role: "system", content: "请执行完成判定，评估目标是否达成。" },
      ],
    });
    expect(isGoalVerificationRequest(body)).toBe(true);
  });

  it("带非空工具（工作轮 streamText）即使含标记 → 非判定请求", () => {
    const body = JSON.stringify({
      model: "m",
      stream: true,
      tools: [{ type: "function", function: { name: "read_file" } }],
      messages: [
        { role: "system", content: `${GOAL_VERIFICATION_MARKER} 判定` },
      ],
    });
    expect(isGoalVerificationRequest(body)).toBe(false);
  });

  it("无标记的非流式请求（generateText 先例：提交消息生成）→ 非判定请求", () => {
    expect(isGoalVerificationRequest(workRoundBody("x", false))).toBe(false);
  });

  it("tools 为空数组 + 标记 → 判定请求（无工具语义）", () => {
    const body = JSON.stringify({
      model: "m",
      tools: [],
      messages: [{ role: "system", content: GOAL_VERIFICATION_MARKER }],
    });
    expect(isGoalVerificationRequest(body)).toBe(true);
  });
});

describe("startGoalMockProvider：两线脚本化分流", () => {
  it("判定请求走判定线：非流式应答 chat completion JSON，content 为裸 verdict JSON", async () => {
    const { handle, workIndexes, verdictIndexes } = await launchTwoLineStub();
    const response = await postChat(handle.port, verdictRoundBody(false));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.object).toBe("chat.completion");
    expect(payload.choices[0].message.role).toBe("assistant");
    expect(JSON.parse(payload.choices[0].message.content)).toEqual({
      passed: false,
      reason: "尚有步骤未完成",
      nextAction: "继续实现",
    });
    expect(workIndexes).toEqual([]);
    expect(verdictIndexes).toEqual([1]);
  });

  it("无标记非流式请求仍走工作轮线（现状兼容，index 从 1 起）", async () => {
    const { handle, workIndexes, verdictIndexes } = await launchTwoLineStub();
    const response = await postChat(handle.port, workRoundBody("x", false));
    expect(response.status).toBe(200);
    expect(workIndexes).toEqual([1]);
    expect(verdictIndexes).toEqual([]);
  });

  it("两线 index 分账互不串线：交替请求各自连续计数", async () => {
    const { handle, workIndexes, verdictIndexes } = await launchTwoLineStub();
    await postChat(handle.port, workRoundBody("w1"));
    await postChat(handle.port, verdictRoundBody(false));
    await postChat(handle.port, workRoundBody("w2"));
    await postChat(handle.port, verdictRoundBody(false));
    await postChat(handle.port, workRoundBody("w3"));
    expect(workIndexes).toEqual([1, 2, 3]);
    expect(verdictIndexes).toEqual([1, 2]);
  });

  it("流式判定请求：SSE 文本帧回放 verdict 文本", async () => {
    const { handle } = await launchTwoLineStub();
    const response = await postChat(handle.port, verdictRoundBody(true));
    expect(sseContent(response.text)).toBe(
      JSON.stringify({
        passed: false,
        reason: "尚有步骤未完成",
        nextAction: "继续实现",
      })
    );
  });

  it("code-fence 形态：content 为代码围栏包裹的 verdict JSON", async () => {
    const handle = await startGoalMockProvider({
      work(ctx) {
        ctx.textRound("占位");
      },
      verdict(ctx) {
        ctx.verdictRound(
          { passed: true, reason: "目标已达成", nextAction: "无" },
          "code-fence"
        );
      },
    });
    handles.push({ close: () => handle.server.close() });
    const response = await postChat(handle.port, verdictRoundBody(false));
    const payload = await response.json();
    const content: string = payload.choices[0].message.content;
    expect(content.startsWith("```json")).toBe(true);
    expect(content.endsWith("```")).toBe(true);
    const inner = content.replace(/^```json\n/, "").replace(/\n```$/, "");
    expect(JSON.parse(inner)).toEqual({
      passed: true,
      reason: "目标已达成",
      nextAction: "无",
    });
  });

  it("string-wrapped 形态：content 为外层字符串字面量包裹的 verdict JSON", async () => {
    const handle = await startGoalMockProvider({
      verdict(ctx) {
        ctx.verdictRound(
          { passed: true, reason: "目标已达成", nextAction: "无" },
          "string-wrapped"
        );
      },
    });
    handles.push({ close: () => handle.server.close() });
    const response = await postChat(handle.port, verdictRoundBody(false));
    const payload = await response.json();
    const content: string = payload.choices[0].message.content;
    // 外层是 JSON 字符串字面量（带引号与转义），剥一层后才是 verdict JSON
    expect(content.startsWith('"')).toBe(true);
    expect(JSON.parse(content)).toBe(
      JSON.stringify({
        passed: true,
        reason: "目标已达成",
        nextAction: "无",
      })
    );
  });

  it("isVerdictRequest 可注入覆盖默认识别", async () => {
    const seen: string[] = [];
    const handle = await startGoalMockProvider({
      isVerdictRequest(body) {
        seen.push(body);
        return body.includes('"custom-verdict-signal"');
      },
      work(ctx, { index }) {
        ctx.textRound(`工作轮 ${index}`);
      },
      verdict(ctx) {
        ctx.verdictRound({ passed: true, reason: "r", nextAction: "n" });
      },
    });
    handles.push({ close: () => handle.server.close() });
    const custom = JSON.stringify({
      model: "m",
      messages: [{ role: "user", content: "custom-verdict-signal" }],
    });
    const response = await postChat(handle.port, custom);
    const payload = await response.json();
    expect(JSON.parse(payload.choices[0].message.content).passed).toBe(true);
    expect(seen).toHaveLength(1);
    // 默认 marker 请求不再被识别为判定（覆盖后走工作轮线）
    await postChat(handle.port, verdictRoundBody(false));
    const workResponse = await postChat(handle.port, workRoundBody("w"));
    expect(sseContent(workResponse.text)).toBe("工作轮 2");
  });

  it("verdictRound 返回构造文本，供场景直接断言", async () => {
    let produced = "";
    const handle = await startGoalMockProvider({
      verdict(ctx) {
        produced = ctx.verdictRound(
          { passed: false, reason: "r", nextAction: "n" },
          "raw"
        );
      },
    });
    handles.push({ close: () => handle.server.close() });
    await postChat(handle.port, verdictRoundBody(false));
    expect(JSON.parse(produced)).toEqual({
      passed: false,
      reason: "r",
      nextAction: "n",
    });
  });
});

describe("startMockProvider 既有语义回归（不带判定 options）", () => {
  it("onChat 的 index 仍按请求顺序 1 起连续计数", async () => {
    const indexes: number[] = [];
    const handle = await startMockProvider((ctx, { index }) => {
      indexes.push(index);
      ctx.textRound(`回复 ${index}`);
    });
    handles.push({ close: () => handle.server.close() });
    await postChat(handle.port, workRoundBody("a"));
    await postChat(handle.port, workRoundBody("b", false));
    await postChat(handle.port, workRoundBody("c"));
    expect(indexes).toEqual([1, 2, 3]);
  });
});
