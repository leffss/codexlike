// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { MessageComposer } from "../src/components/MessageComposer";

/**
 * 模型与思考统一选择器（ADR 0024 呈现修订）在任务 composer 的接线：
 * 收起呈现「模型名 · 档位」（Profile 名只进 title）、data-model-value 复合键、
 * 失效/未配置显式提示；打开后点模型/点档位走父级 onSelectModel /
 * onSelectThinkingEffort 原回调。弹层内交互细节见 model-thinking-select-ui。
 */
const profiles = [
  {
    id: "p1",
    name: "GLM",
    models: ["glm-4.7", "glm-4.6"],
    baseURL: "https://a",
    apiKey: "k",
  },
  {
    id: "p2",
    name: "DeepSeek",
    models: ["deepseek-chat"],
    baseURL: "https://b",
    apiKey: "k",
  },
];

function composer(
  props: Partial<Parameters<typeof MessageComposer>[0]> = {}
): Parameters<typeof MessageComposer>[0] {
  return {
    profiles,
    selectedProfileId: "p1",
    selectedModel: "glm-4.6",
    onSelectModel: vi.fn(),
    onSend: () => {},
    workspaceFiles: [],
    disabled: false,
    hint: "输入消息",
    approvalMode: "assist",
    onSelectApprovalMode: () => {},
    thinkingEffort: "low",
    onSelectThinkingEffort: vi.fn(),
    ...props,
  };
}

// jsdom 未实现 ResizeObserver（定位 hook 观察 trigger 用）与 scrollIntoView
//（打开聚焦滚入可视区）：空 stub（先例 workspace-queue-ui.test.tsx）
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("任务 composer 的模型与思考统一选择器", () => {
  it("选中具体模型：收起显示「模型名 · 档位」，data-model-value 为复合键，title 保留 Profile 与完整模型", () => {
    render(createElement(MessageComposer, composer()));
    const trigger = screen.getByTestId("model-thinking-select");
    expect(trigger.textContent).toContain("glm-4.6 · 低");
    expect(trigger.getAttribute("data-model-value")).toBe("p1::glm-4.6");
    expect(trigger.getAttribute("data-thinking-effort")).toBe("low");
    expect(trigger.title).toContain("GLM · glm-4.6");
  });

  it("未显式选模型：选中态回退所选 Profile 列表第一项（新建默认预览）", () => {
    render(createElement(MessageComposer, composer({ selectedModel: null })));
    const trigger = screen.getByTestId("model-thinking-select");
    expect(trigger.textContent).toContain("glm-4.7");
    expect(trigger.getAttribute("data-model-value")).toBe("p1::glm-4.7");
  });

  it("保存的模型已从 Profile 删除：显示「已保存的模型不可用」，值保持原始组合", () => {
    render(
      createElement(MessageComposer, composer({ selectedModel: "glm-4.5" }))
    );
    const trigger = screen.getByTestId("model-thinking-select");
    expect(trigger.textContent).toContain("已保存的模型不可用");
    expect(trigger.getAttribute("data-model-value")).toBe("p1::glm-4.5");
  });

  it("无 Profile：显示「未配置模型」占位（沿用 model-options 文案），复合值落空串", () => {
    render(
      createElement(
        MessageComposer,
        composer({ profiles: [], selectedProfileId: "" })
      )
    );
    const trigger = screen.getByTestId("model-thinking-select");
    expect(trigger.textContent).toContain("未配置模型");
    expect(trigger.getAttribute("data-model-value")).toBe("");
  });

  it("点模型即时走 onSelectModel 且弹层保持打开；点档位走 onSelectThinkingEffort 并关闭", () => {
    const props = composer();
    render(createElement(MessageComposer, props));
    fireEvent.click(screen.getByTestId("model-thinking-select"));
    fireEvent.change(screen.getByTestId("model-thinking-provider"), {
      target: { value: "p2" },
    });
    fireEvent.click(
      screen.getByTestId("model-thinking-model-option-p2::deepseek-chat")
    );
    expect(props.onSelectModel).toHaveBeenCalledExactlyOnceWith(
      "p2",
      "deepseek-chat"
    );
    expect(screen.getByTestId("model-thinking-popover")).toBeTruthy();
    fireEvent.click(screen.getByTestId("model-thinking-effort-high"));
    expect(props.onSelectThinkingEffort).toHaveBeenCalledExactlyOnceWith(
      "high"
    );
    expect(screen.queryByTestId("model-thinking-popover")).toBeNull();
  });

  it("readOnly 只读：选择器禁用；无任务（approvalMode=null）整体禁用，与审批/技能同源", () => {
    const busyView = render(
      createElement(MessageComposer, composer({ readOnly: true }))
    );
    expect(
      (screen.getByTestId("model-thinking-select") as HTMLButtonElement)
        .disabled
    ).toBe(true);
    busyView.unmount();

    const noTask = composer({ readOnly: false, approvalMode: null });
    render(createElement(MessageComposer, noTask));
    expect(
      (screen.getByTestId("model-thinking-select") as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("窄宽度降级惯例不回退：选择器保持 min-w-0 shrink（65ad205）", () => {
    render(createElement(MessageComposer, composer()));
    expect(screen.getByTestId("model-thinking-select").className).toContain(
      "min-w-0"
    );
    expect(screen.getByTestId("model-thinking-select").className).toContain(
      "shrink"
    );
  });
});
