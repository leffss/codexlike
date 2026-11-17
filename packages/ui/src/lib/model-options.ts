import type { ProviderProfile } from "@codexlike/agent-core";

/**
 * 模型选择器的选项与值编码（票 02，ADR 0024 二元组）：
 * 选择器平铺「Profile 名 · 模型名」，value 为 `${profileId}::${model}`
 * 复合键（双冒号分隔——profileId 是存储层生成的稳定标识不含 `::`，
 * 模型名常见单冒号如 Ollama 的 `llama3:8b`，双冒号为界不歧义）。
 * composer 与设置页子代理分区共用同一编解码。
 */

/** 复合键分隔符（见上） */
const MODEL_VALUE_SEPARATOR = "::";

export interface ModelOption {
  value: string;
  label: string;
  title: string;
}

/** (profileId, 模型名) → 选择器 value */
export function modelOptionValue(profileId: string, model: string): string {
  return `${profileId}${MODEL_VALUE_SEPARATOR}${model}`;
}

/** 选择器 value → (profileId, 模型名)；非复合键（兜底项 value）返回 null */
export function parseModelOptionValue(
  value: string
): { profileId: string; model: string } | null {
  const separatorIndex = value.indexOf(MODEL_VALUE_SEPARATOR);
  if (separatorIndex === -1) return null;
  return {
    profileId: value.slice(0, separatorIndex),
    model: value.slice(separatorIndex + MODEL_VALUE_SEPARATOR.length),
  };
}

/**
 * 子代理分区「跟随主任务模型」占位值（review 修复 1，ADR 0024）：
 * 存量/未选具体模型时 settings.model 为 null——回显用复合键的空 model 位
 * （`${profileId}::`）表达「已选 Profile、未选具体模型」，不落成列表第一项：
 * 未改选直接保存保留 null（子代理跟随主任务当前所用模型，Profile
 * 重排序同样跟随），用户仍可主动改选具体模型。保存侧经
 * subagentSettingsOfValue 把空 model 位归一回 null。
 */
export function subagentFollowModelValue(profileId: string): string {
  return modelOptionValue(profileId, "");
}

/**
 * 子代理分区选择器 value → 保存参数：非复合键（value=""）= 同主模型
 * （providerProfileId 与 model 一并 null）；空 model 位（跟随占位）保留
 * providerProfileId、model 归一 null；具体复合键原样通过。
 */
export function subagentSettingsOfValue(value: string): {
  providerProfileId: string | null;
  model: string | null;
} {
  const parsed = parseModelOptionValue(value);
  if (parsed === null) {
    return { providerProfileId: null, model: null };
  }
  return {
    providerProfileId: parsed.profileId,
    model: parsed.model === "" ? null : parsed.model,
  };
}

/** Profile 是否提供 (id, 模型名) 这个组合 */
function hasModel(
  profiles: readonly ProviderProfile[],
  profileId: string,
  model: string
): boolean {
  return profiles.some(
    (profile) => profile.id === profileId && profile.models.includes(model)
  );
}

/**
 * composer 模型选择器选项（票 02）：
 * - profiles 为空 → 「未配置模型」占位（value ""）；
 * - 保存的 (Profile, 模型) 不在列表（Profile 被删或模型被删）→
 *   「已保存的模型不可用」项（value 为原始保存组合，选中态可见失效提示，
 *   实际执行回退由 agent-core 解析为列表第一项）；
 * - 平铺每个 Profile 的每个模型，label「Profile 名 · 模型名」。
 * selectedModel 为 null/undefined 表示未显式选模型（旧任务/新建默认）：
 * 不产生不可用项，选中态落在所选 Profile 的第一项上。
 */
export function composerModelOptions(
  profiles: readonly ProviderProfile[],
  selectedProfileId: string,
  selectedModel: string | null | undefined
): ModelOption[] {
  const options: ModelOption[] = [];
  if (profiles.length === 0) {
    return [{ value: "", label: "未配置模型", title: "未配置模型" }];
  }
  if (
    selectedProfileId !== "" &&
    (selectedModel === null || selectedModel === undefined
      ? !profiles.some((profile) => profile.id === selectedProfileId)
      : !hasModel(profiles, selectedProfileId, selectedModel))
  ) {
    options.push({
      value: modelOptionValue(selectedProfileId, selectedModel ?? ""),
      label: "已保存的模型不可用",
      title: "已保存的模型不可用，请重新选择模型",
    });
  }
  for (const profile of profiles) {
    for (const model of profile.models) {
      options.push({
        value: modelOptionValue(profile.id, model),
        label: `${profile.name} · ${model}`,
        title: `${profile.name} · ${model}（对下一条消息生效）`,
      });
    }
  }
  return options;
}
