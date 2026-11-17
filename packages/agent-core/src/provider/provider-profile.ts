/**
 * Provider Profile：一份 LLM 接入配置（见 GLOSSARY.md）。
 * 全部走 OpenAI 兼容协议（baseURL + apiKey + 模型列表），可在界面中配置多份并切换。
 */

/** 一份完整的 Provider Profile（`apiKey` 仅存在于内存与加密落盘形态） */
export interface ProviderProfile {
  /** 稳定标识（存储层生成） */
  id: string;
  /** 显示名称，如「GLM」「DeepSeek」 */
  name: string;
  /** OpenAI 兼容端点地址，如 `https://open.bigmodel.cn/api/paas/v4` */
  baseURL: string;
  /** API key；本地端点（如 Ollama）允许为空 */
  apiKey: string;
  /**
   * 模型名列表（ADR 0024：一份接入配置挂 N 个模型）。
   * 第一项是新建任务与未显式选模型任务的回退项（无「默认模型」概念）。
   */
  models: string[];
  /**
   * 模型上下文窗口（tokens，可选；上下文告警阈值 = 窗口 × 80%）。
   * 未配置时按默认 128k 估算（见 context/context-warning）。
   */
  contextWindowTokens?: number;
}

/** 设置页表单输入（无 `id`，`id` 由存储层生成） */
export type ProviderProfileInput = Omit<ProviderProfile, "id">;

/**
 * 解析后的模型二元组（ADR 0024：任务/子代理的模型选择粒度）：
 * profile 为完整 Provider Profile，model 为该 Profile 模型列表内的具体
 * 模型名（经 resolveModelOf 归一）——主任务 sendMessage/compact 与子代理
 * SubagentsConfig.resolveModel 均以此形状流转，消费点不再各自内联。
 */
export interface ResolvedModel {
  profile: ProviderProfile;
  model: string;
}

/** 按字段给出中文错误消息；空对象表示校验通过 */
export type ProviderProfileErrors = Partial<
  Record<
    "name" | "baseURL" | "apiKey" | "models" | "contextWindowTokens",
    string
  >
>;

/**
 * Profile 模型列表第一项（ADR 0024：新建任务与未显式选模型任务的回退项）。
 * 校验层保证列表非空；空列表属非法状态，兜底返回空串防崩溃。
 */
export function firstModelOf(profile: Pick<ProviderProfile, "models">): string {
  return profile.models[0] ?? "";
}

/**
 * 任务级模型解析（票 02，ADR 0024）：把 (Profile, model) 二元组里的 model
 * 归一为该 Profile 列表内的有效模型——在列表内原样返回；缺省（新建任务未
 * 显式选择 / 存量任务无 model 记录）或已从列表删除（记录失效）一律回退
 * 列表第一项。无「默认模型」跟随概念：回退只发生在解析瞬间，不写回任务
 * 记录（用户重新选择前 UI 以「已保存的模型不可用」提示呈现失效态）。
 */
export function resolveModelOf(
  profile: Pick<ProviderProfile, "models">,
  model?: string | null
): string {
  return model !== null && model !== undefined && profile.models.includes(model)
    ? model
    : firstModelOf(profile);
}

/** 校验 Provider Profile 表单输入（URL 合法、name 非空、模型列表非空/逐项非空/去重、上下文窗口为正整数），供 UI 与存储层共用 */
export function validateProviderProfile(
  input: ProviderProfileInput
): ProviderProfileErrors {
  const errors: ProviderProfileErrors = {};

  if (input.name.trim() === "") {
    errors.name = "请填写名称";
  }

  // OpenAI 兼容端点必须是合法 URL（http/https），本地端点如 `http://localhost:11434/v1` 也合法
  try {
    const url = new URL(input.baseURL);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      errors.baseURL = "baseURL 不是合法的 URL";
    }
  } catch {
    errors.baseURL = "baseURL 不是合法的 URL";
  }

  const models = input.models ?? [];
  if (models.length === 0) {
    errors.models = "请至少添加一个模型";
  } else if (models.some((model) => model.trim() === "")) {
    errors.models = "模型名称不能为空";
  } else if (
    new Set(models.map((model) => model.trim())).size !== models.length
  ) {
    errors.models = "模型名称不能重复";
  }

  if (
    input.contextWindowTokens !== undefined &&
    (!Number.isInteger(input.contextWindowTokens) ||
      input.contextWindowTokens <= 0)
  ) {
    errors.contextWindowTokens = "上下文窗口必须是正整数（tokens）";
  }

  return errors;
}
