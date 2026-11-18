// @vitest-environment jsdom
import { createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ProviderProfile, ThinkingEffort } from "@codexlike/agent-core";
import { ModelThinkingSelect } from "../src/components/ModelThinkingSelect";

const profiles: ProviderProfile[] = [
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

type Props = Parameters<typeof ModelThinkingSelect>[0];
function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    profiles,
    selectedProfileId: "p1",
    selectedModel: "glm-4.6",
    thinkingEffort: "low",
    onSelectModel: vi.fn(),
    onSelectThinkingEffort: vi.fn(),
    ...overrides,
  };
}

function Harness(props: Props) {
  const [model, setModel] = useState({
    profileId: props.selectedProfileId,
    model: props.selectedModel,
  });
  const [effort, setEffort] = useState<ThinkingEffort | null>(
    props.thinkingEffort
  );
  return createElement(ModelThinkingSelect, {
    ...props,
    selectedProfileId: model.profileId,
    selectedModel: model.model,
    thinkingEffort: effort,
    onSelectModel(profileId, nextModel) {
      props.onSelectModel(profileId, nextModel);
      setModel({ profileId, model: nextModel });
    },
    onSelectThinkingEffort(nextEffort) {
      props.onSelectThinkingEffort(nextEffort);
      setEffort(nextEffort);
    },
  });
}

// jsdom 未实现 ResizeObserver（定位 hook 观察 trigger 用）与 scrollIntoView
//（键盘导航/打开聚焦滚入可视区）：空 stub（先例 workspace-queue-ui.test.tsx）
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

describe("模型与思考统一选择器", () => {
  it("弹层经 use-stablePopover 定位：fixed + 锁定尺寸，中部模型区独立滚动、头尾固定", () => {
    const props = baseProps();
    render(createElement(Harness, props));
    fireEvent.click(screen.getByTestId("model-thinking-select"));
    const popover = screen.getByTestId<HTMLDivElement>(
      "model-thinking-popover"
    );
    expect(popover.style.position).toBe("fixed");
    expect(popover.className).toContain("flex-col");
    const models = screen.getByTestId("model-thinking-models");
    expect(models.className).toContain("overflow-y-auto");
    expect(models.className).toContain("flex-1");
    expect(screen.getByTestId("model-thinking-efforts").previousSibling).toBe(
      models
    );
  });

  it("Tab 流转：模型↔Provider↔档位单向链，档位 Tab 关闭并进 trigger 后下一控件；档位禁用时模型 Tab 放行", () => {
    const props = baseProps();
    render(
      createElement(
        "div",
        null,
        createElement(Harness, props),
        createElement("input", { "aria-label": "页面下一控件" })
      )
    );
    const trigger = screen.getByTestId("model-thinking-select");
    fireEvent.click(trigger);
    const provider = screen.getByTestId("model-thinking-provider");
    const selected = screen.getByTestId(
      "model-thinking-model-option-p1::glm-4.6"
    );

    // 模型 Shift+Tab → Provider；Provider Shift+Tab → 关闭回 trigger
    fireEvent.keyDown(selected, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(provider);
    fireEvent.keyDown(provider, { key: "Tab", shiftKey: true });
    expect(screen.queryByTestId("model-thinking-popover")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // Provider Tab → 当前模型；模型 Tab → 当前档位；档位 Shift+Tab → 模型
    //（重开弹层 portal 重挂载，节点引用需重查）
    fireEvent.click(trigger);
    const provider2 = screen.getByTestId("model-thinking-provider");
    const selected2 = screen.getByTestId(
      "model-thinking-model-option-p1::glm-4.6"
    );
    const effortLow = screen.getByTestId("model-thinking-effort-low");
    fireEvent.keyDown(provider2, { key: "Tab" });
    expect(document.activeElement).toBe(selected2);
    fireEvent.keyDown(selected2, { key: "Tab" });
    expect(document.activeElement).toBe(effortLow);
    fireEvent.keyDown(effortLow, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(selected2);

    // 档位 Tab：关闭弹层并进入 trigger 之后的下一可聚焦控件
    fireEvent.keyDown(effortLow, { key: "Tab" });
    expect(screen.queryByTestId("model-thinking-popover")).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("页面下一控件"));

    // thinkingEffort=null（档位全禁用）：模型 Tab 不拦截，交给浏览器默认离开弹层
    const disabledProps = baseProps({ thinkingEffort: null });
    render(createElement(ModelThinkingSelect, disabledProps));
    const disabledTrigger = screen.getAllByTestId("model-thinking-select")[1]!;
    fireEvent.click(disabledTrigger);
    const modelButton = screen.getByTestId(
      "model-thinking-model-option-p1::glm-4.6"
    );
    const tabEvent = fireEvent.keyDown(modelButton, { key: "Tab" });
    expect(tabEvent).toBe(true);
    expect(screen.getByTestId("model-thinking-popover")).toBeTruthy();
  });

  it("模型 roving focus：打开聚焦已选，方向/Home/End 只移焦，原生按钮激活才保存", () => {
    const props = baseProps();
    render(createElement(Harness, props));
    fireEvent.click(screen.getByTestId("model-thinking-select"));
    const first = screen.getByTestId("model-thinking-model-option-p1::glm-4.7");
    const selected = screen.getByTestId(
      "model-thinking-model-option-p1::glm-4.6"
    );
    expect(document.activeElement).toBe(selected);
    expect(selected.tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);
    fireEvent.keyDown(selected, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    expect(first.tabIndex).toBe(0);
    expect(selected.tabIndex).toBe(-1);
    fireEvent.keyDown(first, { key: "End" });
    expect(document.activeElement).toBe(selected);
    fireEvent.keyDown(selected, { key: "Home" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(selected);
    expect(props.onSelectModel).not.toHaveBeenCalled();
    // jsdom 不合成浏览器原生 button 激活；确认不拦 Enter/Space，再发真实 click 事件。
    expect(fireEvent.keyDown(selected, { key: "Enter" })).toBe(true);
    fireEvent.click(selected, { detail: 0 });
    expect(fireEvent.keyDown(first, { key: " " })).toBe(true);
    fireEvent.click(first, { detail: 0 });
    expect(props.onSelectModel).toHaveBeenLastCalledWith("p1", "glm-4.7");
    expect(screen.getByTestId("model-thinking-popover")).toBeTruthy();
  });
  it("档位 roving ←→/Home/End；Provider Esc 保留原生语义不关层（退出走 Tab 链）；IME 与空列表聚焦", () => {
    const props = baseProps();
    render(createElement(Harness, props));
    const trigger = screen.getByTestId("model-thinking-select");
    fireEvent.click(trigger);
    const efforts = ["auto", "low", "medium", "high", "off"].map((effort) =>
      screen.getByTestId(`model-thinking-effort-${effort}`)
    ) as HTMLButtonElement[];
    expect(efforts[1]!.tabIndex).toBe(0);
    expect(efforts[0]!.tabIndex).toBe(-1);
    fireEvent.keyDown(efforts[1]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(efforts[2]);
    fireEvent.keyDown(efforts[2]!, { key: "End" });
    expect(document.activeElement).toBe(efforts[4]);
    fireEvent.keyDown(efforts[4]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(efforts[3]);
    fireEvent.keyDown(efforts[3]!, { key: "Home" });
    expect(document.activeElement).toBe(efforts[0]);
    expect(props.onSelectThinkingEffort).not.toHaveBeenCalled();

    // 原生 select：Esc 完全保留原生语义（keydown/keyup 均不关主弹层），
    // 键盘退出走 Tab 链——Shift+Tab 关闭回 trigger（下方 Tab 流转用例覆盖）
    const provider = screen.getByTestId("model-thinking-provider");
    fireEvent.keyDown(provider, { key: "Escape" });
    expect(screen.getByTestId("model-thinking-popover")).toBeTruthy();
    fireEvent.keyUp(provider, { key: "Escape" });
    expect(screen.getByTestId("model-thinking-popover")).toBeTruthy();
    fireEvent.keyDown(provider, { key: "Tab", shiftKey: true });
    expect(screen.queryByTestId("model-thinking-popover")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // IME 组合期：方向键/Escape 不触发弹层内操作
    fireEvent.click(trigger);
    const selected = screen.getByTestId(
      "model-thinking-model-option-p1::glm-4.6"
    );
    fireEvent.keyDown(selected, { key: "ArrowDown", isComposing: true });
    expect(document.activeElement).toBe(selected);
    fireEvent.keyDown(selected, { key: "Escape", isComposing: true });
    expect(screen.getByTestId("model-thinking-popover")).toBeTruthy();
    fireEvent.keyDown(selected, { key: "Escape" });
    expect(screen.queryByTestId("model-thinking-popover")).toBeNull();

    // 空列表（trigger 在渲染容器内，弹层控件经 portal 挂 body）：打开聚焦 Provider；Provider Tab 落到档位
    const emptyProps = baseProps({
      profiles: [{ ...profiles[0]!, name: "GLM", models: [] }],
    });
    const view = render(createElement(ModelThinkingSelect, emptyProps));
    fireEvent.click(
      within(view.container).getByTestId("model-thinking-select")
    );
    expect(document.activeElement).toBe(
      screen.getByTestId("model-thinking-provider")
    );
    fireEvent.keyDown(screen.getByTestId("model-thinking-provider"), {
      key: "Tab",
    });
    expect(document.activeElement).toBe(
      screen.getByTestId("model-thinking-effort-low")
    );
    view.unmount();
  });

  it("打开期间 Profile/模型更新实时呈现，浏览 Profile 被删回退首个；空列表不伪造模型或回写", () => {
    const props = baseProps();
    const view = render(createElement(ModelThinkingSelect, props));
    const trigger = screen.getByTestId("model-thinking-select");
    fireEvent.click(trigger);
    fireEvent.change(screen.getByTestId("model-thinking-provider"), {
      target: { value: "p2" },
    });
    view.rerender(
      createElement(ModelThinkingSelect, {
        ...props,
        profiles: [{ ...profiles[0]!, models: [] }],
      })
    );
    expect(
      screen.getByTestId<HTMLSelectElement>("model-thinking-provider").value
    ).toBe("p1");
    expect(screen.getByTestId("model-thinking-models").textContent).toContain(
      "此提供商暂无模型"
    );
    expect(trigger.textContent).toContain("已保存的模型不可用");
    expect(
      within(screen.getByTestId("model-thinking-models")).queryAllByRole(
        "button"
      )
    ).toHaveLength(0);
    view.rerender(
      createElement(ModelThinkingSelect, { ...props, profiles: [] })
    );
    expect(
      screen.getByTestId<HTMLSelectElement>("model-thinking-provider").disabled
    ).toBe(true);
    expect(screen.getByTestId("model-thinking-models").textContent).toContain(
      "未配置模型"
    );
    expect(trigger.getAttribute("data-model-value")).toBe("");
    expect(trigger.title).toContain("glm-4.6");
    view.rerender(
      createElement(ModelThinkingSelect, {
        ...props,
        profiles: [{ ...profiles[0]!, models: ["replacement"] }],
      })
    );
    expect(
      screen.getByTestId("model-thinking-model-option-p1::replacement")
    ).toBeTruthy();
    expect(props.onSelectModel).not.toHaveBeenCalled();
  });
  it.each([
    {
      selectedProfileId: "p1",
      selectedModel: "deleted-model",
      expectedValue: "p1::deleted-model",
      shown: "已保存的模型不可用",
      browse: "p1",
    },
    {
      selectedProfileId: "deleted-profile",
      selectedModel: "saved-model",
      expectedValue: "deleted-profile::saved-model",
      shown: "已保存的模型不可用",
      browse: "p1",
    },
    {
      selectedProfileId: "deleted-profile",
      selectedModel: null,
      expectedValue: "deleted-profile::",
      shown: "已保存的模型不可用",
      browse: "p1",
    },
    {
      selectedProfileId: "",
      selectedModel: null,
      expectedValue: "",
      shown: "请选择模型",
      browse: "p1",
    },
    {
      selectedProfileId: "p1",
      selectedModel: null,
      expectedValue: "p1::glm-4.7",
      shown: "glm-4.7",
      browse: "p1",
    },
  ])("默认/失效值显式回显且浏览回退不回写：$expectedValue", (selection) => {
    const props = baseProps(selection);
    render(createElement(ModelThinkingSelect, props));
    const trigger = screen.getByTestId("model-thinking-select");
    expect(trigger.textContent).toContain(selection.shown);
    expect(trigger.getAttribute("data-model-value")).toBe(
      selection.expectedValue
    );
    fireEvent.click(trigger);
    expect(
      screen.getByTestId<HTMLSelectElement>("model-thinking-provider").value
    ).toBe(selection.browse);
    if (selection.shown === "已保存的模型不可用") {
      expect(screen.getByRole("status").textContent).toContain(
        "已保存的模型不可用"
      );
      if (selection.selectedModel)
        expect(screen.getByRole("status").textContent).toContain(
          selection.selectedModel
        );
      expect(
        within(screen.getByTestId("model-thinking-models")).queryByRole(
          "button",
          { pressed: true }
        )
      ).toBeNull();
    }
    expect(props.onSelectModel).not.toHaveBeenCalled();
    expect(props.onSelectThinkingEffort).not.toHaveBeenCalled();
  });
  it("thinkingEffort=null 仅禁用档位；整体 disabled 关闭并禁止模型和档位操作", () => {
    const props = baseProps({ thinkingEffort: null });
    const view = render(createElement(ModelThinkingSelect, props));
    const trigger = screen.getByTestId<HTMLButtonElement>(
      "model-thinking-select"
    );
    expect(trigger.disabled).toBe(false);
    fireEvent.click(trigger);
    const effort = screen.getByTestId<HTMLButtonElement>(
      "model-thinking-effort-high"
    );
    expect(effort.disabled).toBe(true);
    fireEvent.click(effort);
    expect(props.onSelectThinkingEffort).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByTestId("model-thinking-model-option-p1::glm-4.7")
    );
    expect(props.onSelectModel).toHaveBeenCalledWith("p1", "glm-4.7");
    view.rerender(
      createElement(ModelThinkingSelect, { ...props, disabled: true })
    );
    expect(trigger.disabled).toBe(true);
    expect(screen.queryByTestId("model-thinking-popover")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.queryByTestId("model-thinking-popover")).toBeNull();
    view.rerender(createElement(ModelThinkingSelect, props));
    expect(screen.queryByTestId("model-thinking-popover")).toBeNull();
  });
  it("Escape/外点关闭不撤销模型，重开定位已保存 Profile；外点不抢焦点", () => {
    const props = baseProps();
    render(
      <>
        <Harness {...props} />
        <input aria-label="外部输入" />
      </>
    );
    const trigger = screen.getByTestId("model-thinking-select");
    fireEvent.click(trigger);
    fireEvent.change(screen.getByTestId("model-thinking-provider"), {
      target: { value: "p2" },
    });
    const selected = screen.getByTestId(
      "model-thinking-model-option-p2::deepseek-chat"
    );
    fireEvent.click(selected);
    fireEvent.keyDown(selected, { key: "Escape" });
    expect(screen.queryByTestId("model-thinking-popover")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("data-model-value")).toBe("p2::deepseek-chat");
    fireEvent.click(trigger);
    expect(
      screen.getByTestId<HTMLSelectElement>("model-thinking-provider").value
    ).toBe("p2");
    fireEvent.change(screen.getByTestId("model-thinking-provider"), {
      target: { value: "p1" },
    });
    const outside = screen.getByLabelText("外部输入");
    outside.focus();
    fireEvent.pointerDown(outside);
    expect(screen.queryByTestId("model-thinking-popover")).toBeNull();
    expect(document.activeElement).toBe(outside);
    fireEvent.click(trigger);
    expect(
      screen.getByTestId<HTMLSelectElement>("model-thinking-provider").value
    ).toBe("p2");
    expect(props.onSelectModel).toHaveBeenCalledTimes(1);
  });
  it("底部固定五档，点档位即时保存并关闭，焦点先归还触发器", () => {
    const props = baseProps({
      onSelectThinkingEffort: vi.fn(() => {
        expect(document.activeElement).toBe(
          screen.getByTestId("model-thinking-select")
        );
      }),
    });
    render(createElement(Harness, props));
    const trigger = screen.getByTestId("model-thinking-select");
    fireEvent.click(trigger);
    const group = screen.getByRole("group", { name: "思考档位" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.getAttribute("data-effort"))
    ).toEqual(["auto", "low", "medium", "high", "off"]);
    expect(
      screen
        .getByTestId("model-thinking-effort-low")
        .getAttribute("aria-pressed")
    ).toBe("true");
    fireEvent.click(screen.getByTestId("model-thinking-effort-high"));
    expect(props.onSelectThinkingEffort).toHaveBeenCalledExactlyOnceWith(
      "high"
    );
    expect(props.onSelectModel).not.toHaveBeenCalled();
    expect(screen.queryByTestId("model-thinking-popover")).toBeNull();
    expect(trigger.textContent).toBe("glm-4.6 · 高");
  });
  it("提供商只筛选，点模型即时保存二元组、不改档位且保持弹层打开", () => {
    const props = baseProps();
    render(createElement(Harness, props));
    const trigger = screen.getByTestId("model-thinking-select");
    expect(trigger.textContent).toBe("glm-4.6 · 低");
    expect(trigger.title).toContain("GLM · glm-4.6");
    expect(trigger.getAttribute("data-model-value")).toBe("p1::glm-4.6");
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "模型与思考" });
    expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
    const provider = screen.getByTestId("model-thinking-provider");
    expect(provider.tagName).toBe("SELECT");
    expect(
      within(screen.getByRole("group", { name: "模型" })).getAllByRole("button")
    ).toHaveLength(2);
    fireEvent.change(provider, { target: { value: "p2" } });
    expect(props.onSelectModel).not.toHaveBeenCalled();
    expect(trigger.getAttribute("data-model-value")).toBe("p1::glm-4.6");
    fireEvent.click(
      screen.getByTestId("model-thinking-model-option-p2::deepseek-chat")
    );
    expect(props.onSelectModel).toHaveBeenCalledExactlyOnceWith(
      "p2",
      "deepseek-chat"
    );
    expect(props.onSelectThinkingEffort).not.toHaveBeenCalled();
    expect(trigger.getAttribute("data-thinking-effort")).toBe("low");
    expect(trigger.textContent).toBe("deepseek-chat · 低");
    expect(screen.getByTestId("model-thinking-popover")).toBe(dialog);
    expect(
      screen
        .getByTestId("model-thinking-model-option-p2::deepseek-chat")
        .getAttribute("aria-pressed")
    ).toBe("true");
  });
});
