import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageComposer } from "../src/components/MessageComposer";

/**
 * 模型选择器（票 02，ADR 0024）：选项平铺「Profile 名 · 模型名」，选中值
 * 为复合键；「未配置模型」「已保存的模型不可用」兜底态沿用；窄宽度降级
 * 惯例（选择器 min-w-0 shrink，65ad205）不回退。
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

function selectorOpenTag(html: string): string | undefined {
  return new RegExp(`<button[^>]*data-testid="profile-select"[^>]*>`).exec(
    html
  )?.[0];
}

function composer(
  props: Partial<Parameters<typeof MessageComposer>[0]> = {}
): string {
  return renderToStaticMarkup(
    createElement(MessageComposer, {
      profiles,
      selectedProfileId: "p1",
      selectedModel: "glm-4.6",
      onSelectModel: () => {},
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

describe("模型选择器（票 02 平铺）", () => {
  it("选中具体模型：trigger 显示「Profile 名 · 模型名」，data-value 为复合键", () => {
    const html = composer();
    const open = selectorOpenTag(html)!;
    expect(html).toContain("GLM · glm-4.6");
    expect(open).toContain('data-value="p1::glm-4.6"');
  });

  it("未显式选模型：选中态回退所选 Profile 列表第一项（新建默认预览）", () => {
    const html = composer({ selectedModel: null });
    const open = selectorOpenTag(html)!;
    expect(open).toContain('data-value="p1::glm-4.7"');
    expect(html).toContain("GLM · glm-4.7");
  });

  it("保存的模型已从 Profile 删除：显示「已保存的模型不可用」，值保持原始组合", () => {
    const html = composer({ selectedModel: "glm-4.5" });
    const open = selectorOpenTag(html)!;
    expect(open).toContain('data-value="p1::glm-4.5"');
    expect(html).toContain("已保存的模型不可用");
  });

  it("无 Profile：保留「未配置模型」占位", () => {
    const html = composer({ profiles: [], selectedProfileId: "" });
    const open = selectorOpenTag(html)!;
    expect(open).toContain('data-value=""');
    expect(html).toContain("未配置模型");
  });

  it("窄宽度降级惯例不回退：选择器保持 min-w-0 shrink（65ad205）", () => {
    const open = selectorOpenTag(composer())!;
    expect(open).toContain("min-w-0");
    expect(open).toContain("shrink");
  });
});
