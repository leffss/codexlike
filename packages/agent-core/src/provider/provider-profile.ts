/**
 * Provider Profile：一份 LLM 接入配置（见 GLOSSARY.md）。
 * 全部走 OpenAI 兼容协议（baseURL + apiKey + model），可在界面中配置多份并切换。
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
  /** 模型标识，如 `glm-4.7` */
  model: string;
}

/** 设置页表单输入（无 `id`，`id` 由存储层生成） */
export type ProviderProfileInput = Omit<ProviderProfile, 'id'>;

/** 按字段给出中文错误消息；空对象表示校验通过 */
export type ProviderProfileErrors = Partial<
  Record<'name' | 'baseURL' | 'apiKey' | 'model', string>
>;

/** 校验 Provider Profile 表单输入（URL 合法、name/model 非空），供 UI 与存储层共用 */
export function validateProviderProfile(
  input: ProviderProfileInput,
): ProviderProfileErrors {
  const errors: ProviderProfileErrors = {};

  if (input.name.trim() === '') {
    errors.name = '请填写名称';
  }

  // OpenAI 兼容端点必须是合法 URL（http/https），本地端点如 `http://localhost:11434/v1` 也合法
  try {
    const url = new URL(input.baseURL);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.baseURL = 'baseURL 不是合法的 URL';
    }
  } catch {
    errors.baseURL = 'baseURL 不是合法的 URL';
  }

  if (input.model.trim() === '') {
    errors.model = '请填写模型名称';
  }

  return errors;
}
