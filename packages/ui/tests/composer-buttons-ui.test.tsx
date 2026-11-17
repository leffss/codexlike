import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { MessageComposer } from "../src/components/MessageComposer";

function composer(props: Partial<Parameters<typeof MessageComposer>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(MessageComposer, {
      profiles: [
        {
          id: "p1",
          name: "Mock",
          models: ["mock-model"],
          baseURL: "http://127.0.0.1:9/v1",
          apiKey: "sk-test",
        },
      ],
      selectedProfileId: "p1",
      onSelectProfile: () => {},
      onSend: () => {},
      workspaceFiles: [],
      disabled: false,
      hint: "输入消息",
      approvalMode: "assist",
      onSelectApprovalMode: () => {},
      thinkingEffort: "auto",
      onSelectThinkingEffort: () => {},
      ...props,
    })
  );
}

function openTag(html: string, testId: string): string | undefined {
  return new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(
    html
  )?.[0];
}

it("忙且有输入（票 05）：「加入队列」主操作与「停止」并排，无发送按钮", () => {
  const html = composer({
    streaming: true,
    onStop: () => {},
    draftValue: "接着做第二步",
  });
  expect(html).toContain('data-testid="composer-enqueue"');
  expect(html).toContain('data-testid="composer-stop"');
  expect(html).not.toContain('data-testid="composer-send"');
  expect(html).toContain("加入队列");
  // 「加入队列」是主操作（与空闲发送按钮同为 accent 实心样式）；停止保持危险色
  expect(openTag(html, "composer-enqueue")).toContain("bg-accent");
  expect(openTag(html, "composer-stop")).toContain("bg-danger-solid");
});

it("忙且无输入：仅停止按钮，外观与现状一致", () => {
  const html = composer({ streaming: true, onStop: () => {}, draftValue: "" });
  expect(html).toContain('data-testid="composer-stop"');
  expect(html).not.toContain('data-testid="composer-enqueue"');
  expect(html).not.toContain('data-testid="composer-send"');
});

it("空闲时：单发送按钮，与现状一致（有无草稿均如此）", () => {
  for (const draftValue of ["", "准备好下一条"]) {
    const html = composer({ draftValue });
    expect(html).toContain('data-testid="composer-send"');
    expect(html).not.toContain('data-testid="composer-stop"');
    expect(html).not.toContain('data-testid="composer-enqueue"');
  }
});

it("忙时禁用（等待用户交互等）：不提供入队，仅停止按钮", () => {
  const html = composer({
    streaming: true,
    onStop: () => {},
    disabled: true,
    draftValue: "想插队的话",
  });
  expect(html).toContain('data-testid="composer-stop"');
  expect(html).not.toContain('data-testid="composer-enqueue"');
  expect(html).not.toContain('data-testid="composer-send"');
});
