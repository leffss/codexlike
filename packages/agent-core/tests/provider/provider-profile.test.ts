import { describe, expect, it } from "vitest";

import {
  firstModelOf,
  validateProviderProfile,
  type ProviderProfileInput,
} from "../../src/index";

describe("validateProviderProfile（Provider Profile 表单校验）", () => {
  const validInput: ProviderProfileInput = {
    name: "GLM",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    apiKey: "sk-test",
    models: ["glm-4.7"],
  };

  it("合法输入返回空错误对象（校验通过）", () => {
    expect(validateProviderProfile(validInput)).toEqual({});
  });

  it("name 为空时给出 name 错误", () => {
    const errors = validateProviderProfile({
      ...validInput,
      name: " ",
    });

    expect(errors.name).toBe("请填写名称");
  });

  it("baseURL 不是合法 URL 时给出 baseURL 错误", () => {
    const errors = validateProviderProfile({
      ...validInput,
      baseURL: "not-a-url",
    });

    expect(errors.baseURL).toBe("baseURL 不是合法的 URL");
  });

  it("模型列表为空时给出 models 错误", () => {
    const errors = validateProviderProfile({
      ...validInput,
      models: [],
    });

    expect(errors.models).toBe("请至少添加一个模型");
  });

  it("模型名 trim 后为空时给出 models 错误", () => {
    const errors = validateProviderProfile({
      ...validInput,
      models: ["glm-4.7", "  "],
    });

    expect(errors.models).toBe("模型名称不能为空");
  });

  it("模型名 trim 后重复时给出 models 错误", () => {
    const errors = validateProviderProfile({
      ...validInput,
      models: ["glm-4.7", "glm-4.6", " glm-4.7 "],
    });

    expect(errors.models).toBe("模型名称不能重复");
  });

  it("多个互不重复的模型名通过校验", () => {
    expect(
      validateProviderProfile({
        ...validInput,
        models: ["glm-4.7", "glm-4.6", " glm-4.5-air "],
      })
    ).toEqual({});
  });

  it("上下文窗口（可选）：正整数通过；非整数/非正数给出中文错误；缺省合法", () => {
    expect(
      validateProviderProfile({ ...validInput, contextWindowTokens: 200_000 })
    ).toEqual({});
    expect(
      validateProviderProfile(validInput).contextWindowTokens
    ).toBeUndefined();

    expect(
      validateProviderProfile({ ...validInput, contextWindowTokens: 1.5 })
        .contextWindowTokens
    ).toBe("上下文窗口必须是正整数（tokens）");
    expect(
      validateProviderProfile({ ...validInput, contextWindowTokens: 0 })
        .contextWindowTokens
    ).toBe("上下文窗口必须是正整数（tokens）");
    expect(
      validateProviderProfile({
        ...validInput,
        contextWindowTokens: Number.NaN,
      }).contextWindowTokens
    ).toBe("上下文窗口必须是正整数（tokens）");
  });
});

describe("firstModelOf（Profile 模型列表第一项）", () => {
  it("返回列表第一项（新建任务与未显式选模型任务的回退项）", () => {
    expect(firstModelOf({ models: ["glm-4.7", "glm-4.6"] })).toBe("glm-4.7");
  });

  it("列表为空时兜底返回空串（校验层保证非空，此处仅防崩溃）", () => {
    expect(firstModelOf({ models: [] })).toBe("");
  });
});
