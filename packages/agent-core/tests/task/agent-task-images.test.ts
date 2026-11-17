import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ModelMessage, ToolModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ProviderProfile } from "../../src/provider/provider-profile";
import { createAgentTask } from "../../src/task/agent-task";
import { createSqliteTaskStore } from "../../src/task/persistence";
import type { TaskEvent, TaskRecord } from "../../src/task/types";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../src/tools/types";

const profile: ProviderProfile = {
  id: "profile-1",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  models: ["glm-4.7"],
};

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function taskRecord(workspacePath: string): TaskRecord {
  return {
    id: "task-shot",
    title: "截图任务",
    workspacePath,
    providerProfileId: null,
    model: null,
    status: "idle",
    approvalMode: "assist",
    workspaceMode: "local",
    projectId: null,
    workspaceOriginPath: null,
    archivedAt: null,
    createdAt: "2026-11-11T08:00:00.000Z",
    updatedAt: "2026-11-11T08:00:00.000Z",
  };
}

/** 假截图工具：返回 output + images（真实截图行为在 tests/browser 覆盖，这里只测回填管线） */
function fakeScreenshotTool(captured: ToolExecutionContext[]): ToolDefinition {
  return {
    name: "browser_screenshot",
    description: "测试用假截图工具",
    parameters: { type: "object", properties: {} },
    permission: "readonly",
    async execute(_args, context) {
      captured.push(context);
      return {
        output: "整页截图已保存：C:\\shots\\call-1.png（PNG，12 KB）",
        isError: false,
        images: [{ mediaType: "image/png", data: PNG_BASE64 }],
      };
    },
  };
}

function textRound(
  deltas: string[]
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "text-1" });
      for (const delta of deltas) {
        controller.enqueue({ type: "text-delta", id: "text-1", delta });
      }
      controller.enqueue({ type: "text-end", id: "text-1" });
      controller.enqueue({
        type: "finish",
        usage: {
          inputTokens: {
            total: 1,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 2, text: undefined, reasoning: undefined },
        },
        finishReason: { unified: "stop", raw: "stop" },
      });
      controller.close();
    },
  });
}

function usage() {
  return {
    inputTokens: {
      total: 1,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 2, text: undefined, reasoning: undefined },
  };
}

/** 第一轮：发起 tool call；第二轮：收尾文本 */
function scriptedToolThenText() {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      if (call++ === 0) {
        const stream = new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "browser_screenshot",
              input: "{}",
            });
            controller.enqueue({
              type: "finish",
              usage: usage(),
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
            });
            controller.close();
          },
        });
        return { stream };
      }
      return { stream: textRound(["截图看起来不错"]) };
    },
  });
}

async function collect(
  iterable: AsyncIterable<TaskEvent>
): Promise<TaskEvent[]> {
  const events: TaskEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function lastToolMessage(prompt: ModelMessage[]): ToolModelMessage {
  const message = prompt.at(-1);
  if (message?.role !== "tool") {
    throw new Error(`预期最后一条 prompt 消息是 tool，实际：${message?.role}`);
  }
  return message;
}

/** 从 tool 消息里取唯一的 tool-result part（联合类型收窄集中在此） */
function singleToolResult(message: ToolModelMessage) {
  const part = message.content.find(
    (
      candidate
    ): candidate is Extract<
      ToolModelMessage["content"][number],
      { type: "tool-result" }
    > => candidate.type === "tool-result"
  );
  if (part === undefined) {
    throw new Error("tool 消息中未找到 tool-result part");
  }
  return part;
}

async function runTask(
  options: { attachToolImages?: boolean },
  captured: ToolExecutionContext[]
) {
  const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
  const persistence = createSqliteTaskStore(":memory:");
  const record = taskRecord(workspace);
  persistence.insertTask(record);
  const model = scriptedToolThenText();
  const task = createAgentTask({
    record,
    persistence,
    history: [],
    languageModelFor: () => model,
    tools: [fakeScreenshotTool(captured)],
    attachToolImages: options.attachToolImages,
    now: () => "2026-11-11T08:00:01.000Z",
  });
  const events = await collect(task.sendMessage({ text: "截个图", profile }));
  return { events, model };
}

describe("工具结果附图（截图回填模型：多模态附图 / 纯文本降级）", () => {
  it("默认：截图工具收到任务标识，图片作为 content 块回填模型", async () => {
    const captured: ToolExecutionContext[] = [];
    const { events, model } = await runTask({}, captured);

    expect(events.at(-1)?.type).toBe("assistant-done");
    // 工具执行上下文带 taskId / toolCallId（任务级浏览器与截图文件命名依赖它们）
    expect(captured[0]?.taskId).toBe("task-shot");
    expect(captured[0]?.toolCallId).toBe("call-1");

    // 第二轮 prompt：tool 消息的 output 为 content 块（text + file 图片）
    const toolMessage = lastToolMessage(model.doStreamCalls[1]!.prompt);
    const part = singleToolResult(toolMessage);
    expect(part.toolCallId).toBe("call-1");
    expect(part.output.type).toBe("content");
    const blocks = (part.output as { value: unknown[] }).value;
    expect(blocks).toMatchObject([
      {
        type: "text",
        text: "整页截图已保存：C:\\shots\\call-1.png（PNG，12 KB）",
      },
      {
        type: "file",
        data: { type: "data", data: PNG_BASE64 },
        mediaType: "image/png",
      },
    ]);
  });

  it("降级（attachToolImages=false）：图片不回填，模型只看到文本输出", async () => {
    const { model } = await runTask({ attachToolImages: false }, []);
    const toolMessage = lastToolMessage(model.doStreamCalls[1]!.prompt);
    const part = singleToolResult(toolMessage);
    expect(part.output).toEqual({
      type: "text",
      value: "整页截图已保存：C:\\shots\\call-1.png（PNG，12 KB）",
    });
  });
});
