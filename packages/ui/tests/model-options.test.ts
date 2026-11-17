import { describe, expect, it } from "vitest";

import {
  composerModelOptions,
  modelOptionValue,
  parseModelOptionValue,
  subagentFollowModelValue,
  subagentSettingsOfValue,
} from "../src/lib/model-options";
import type { ProviderProfile } from "@codexlike/agent-core";

/**
 * 模型选择器选项构造（票 02，ADR 0024）：「Profile 名 · 模型名」平铺、
 * 选中值复合键编码、兜底态（「未配置模型」「已保存的模型不可用」）。
 * 纯函数——composer 与设置页子代理分区共用同一编解码。
 */
const profiles: ProviderProfile[] = [
  {
    id: "p1",
    name: "GLM",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    apiKey: "sk-1",
    models: ["glm-4.7", "glm-4.6"],
  },
  {
    id: "p2",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-2",
    models: ["deepseek-chat"],
  },
];

describe("modelOptionValue / parseModelOptionValue（复合键编解码）", () => {
  it("profileId 与模型名编成单一值且可逆", () => {
    const value = modelOptionValue("p1", "glm-4.6");
    expect(value).toBe("p1::glm-4.6");
    expect(parseModelOptionValue(value)).toEqual({
      profileId: "p1",
      model: "glm-4.6",
    });
  });

  it("含单冒号的模型名（如 Ollama 的 llama3:8b）不被拆坏", () => {
    const value = modelOptionValue("p1", "llama3:8b");
    expect(parseModelOptionValue(value)).toEqual({
      profileId: "p1",
      model: "llama3:8b",
    });
  });

  it("非复合键的值（兜底项 value）解析为 null", () => {
    expect(parseModelOptionValue("")).toBeNull();
    expect(parseModelOptionValue("gone")).toBeNull();
  });
});

describe("composerModelOptions（选择器平铺与兜底态）", () => {
  it("每个 Profile 的每个模型平铺为一项，label 为「Profile 名 · 模型名」", () => {
    const options = composerModelOptions(profiles, "p1", "glm-4.6");
    expect(
      options
        .filter((option) => option.value !== "")
        .map((option) => option.label)
    ).toEqual(["GLM · glm-4.7", "GLM · glm-4.6", "DeepSeek · deepseek-chat"]);
    // 选中项在列表内
    expect(options.some((option) => option.value === "p1::glm-4.6")).toBe(true);
  });

  it("profiles 为空时保留「未配置模型」兜底项", () => {
    const options = composerModelOptions([], "", null);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ value: "", label: "未配置模型" });
  });

  it("保存的模型已从 Profile 列表删除：追加「已保存的模型不可用」项（原始值）", () => {
    const options = composerModelOptions(profiles, "p1", "glm-4.5");
    const fallback = options.find(
      (option) => option.label === "已保存的模型不可用"
    );
    expect(fallback?.value).toBe("p1::glm-4.5");
  });

  it("保存的 Profile 已删除：追加「已保存的模型不可用」项（原始 Profile 引用）", () => {
    const options = composerModelOptions(profiles, "gone", "glm-4.7");
    const fallback = options.find(
      (option) => option.label === "已保存的模型不可用"
    );
    expect(fallback?.value).toBe("gone::glm-4.7");
  });

  it("未选模型（新建/旧任务）时不出现不可用项：平铺列表第一项即选中态", () => {
    const options = composerModelOptions(profiles, "p1", null);
    expect(
      options.some((option) => option.label === "已保存的模型不可用")
    ).toBe(false);
    expect(options.some((option) => option.value === "p1::glm-4.7")).toBe(true);
  });
});

describe("子代理分区占位与保存归一（review 修复 1，ADR 0024）", () => {
  it("model 为 null：回显跟随占位（空 model 位复合键），不落成具体模型", () => {
    // 设置页 load 侧：settings.model === null → subagentFollowModelValue
    expect(subagentFollowModelValue("p1")).toBe("p1::");
  });

  it("null → 打开设置 → 不改 → 保存：存储仍为 null（保留 providerProfileId）", () => {
    // 回显值未经用户改选直接走保存归一：model 保持 null，不被写死成
    // Profile 第一项（Profile 重排序后子代理仍跟随主任务当前所用模型）
    const echo = subagentFollowModelValue("p1");
    expect(subagentSettingsOfValue(echo)).toEqual({
      providerProfileId: "p1",
      model: null,
    });
  });

  it("用户主动选具体模型：复合键原样通过", () => {
    expect(subagentSettingsOfValue("p1::glm-4.6")).toEqual({
      providerProfileId: "p1",
      model: "glm-4.6",
    });
  });

  it("选「同主模型」（value 空串）：providerProfileId 与 model 一并 null", () => {
    expect(subagentSettingsOfValue("")).toEqual({
      providerProfileId: null,
      model: null,
    });
  });
});
