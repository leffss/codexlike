import { useState } from "react";

import {
  validateProviderProfile,
  type ProviderProfileErrors,
  type ProviderProfileInput,
} from "@codexlike/agent-core";

const EMPTY_INPUT: ProviderProfileInput = {
  name: "",
  baseURL: "",
  apiKey: "",
  models: [""],
};

/** 上下文窗口字段的字符串形态（'' = 未配置，走默认 128k） */
function windowTokensToText(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function windowTokensFromText(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? Number.NaN : parsed; // 非数字留给校验报中文错误
}

/** 设置页的 Provider Profile 表单：新建/编辑共用，校验复用 agent-core 规则 */
export function ProviderProfileForm(props: {
  initial?: ProviderProfileInput;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (input: ProviderProfileInput) => Promise<void>;
}) {
  const [input, setInput] = useState<ProviderProfileInput>(
    props.initial ?? EMPTY_INPUT
  );
  // 模型区为动态行（ADR 0024）：每行一个模型名，可增删、可上下移排序
  const [models, setModels] = useState<string[]>(
    props.initial?.models.length ? props.initial.models : [""]
  );
  const [windowTokensText, setWindowTokensText] = useState(
    windowTokensToText(props.initial?.contextWindowTokens)
  );
  const [errors, setErrors] = useState<ProviderProfileErrors>({});
  const [submitError, setSubmitError] = useState("");
  const [saving, setSaving] = useState(false);

  function setField(field: "name" | "baseURL" | "apiKey", value: string) {
    setInput((prev) => ({ ...prev, [field]: value }));
  }

  function setModelAt(index: number, value: string) {
    setModels((prev) => prev.map((model, i) => (i === index ? value : model)));
  }

  function addModel() {
    setModels((prev) => [...prev, ""]);
  }

  function removeModel(index: number) {
    setModels((prev) => prev.filter((_, i) => i !== index));
  }

  function moveModel(index: number, offset: -1 | 1) {
    setModels((prev) => {
      const target = index + offset;
      if (target < 0 || target >= prev.length) {
        return prev;
      }
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved ?? "");
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitError("");
    // 上下文窗口为可选字段：空串 → undefined（走默认 128k），数字随表单提交
    const windowTokens = windowTokensFromText(windowTokensText);
    const submitted: ProviderProfileInput = {
      name: input.name,
      baseURL: input.baseURL,
      apiKey: input.apiKey,
      models,
      ...(windowTokens !== undefined
        ? { contextWindowTokens: windowTokens }
        : {}),
    };
    const validation = validateProviderProfile(submitted);
    setErrors(validation);
    if (Object.values(validation).some((message) => message !== undefined)) {
      return;
    }
    setSaving(true);
    try {
      await props.onSubmit(submitted);
    } catch (error) {
      // 主进程 IPC 拒绝（校验失败 / safeStorage 不可用等）的中文消息直接展示
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
      onSubmit={handleSubmit}
    >
      <Field
        label="名称"
        placeholder="如：GLM、DeepSeek"
        value={input.name}
        error={errors.name}
        onChange={(v) => setField("name", v)}
      />
      <Field
        label="baseURL"
        placeholder="https://open.bigmodel.cn/api/paas/v4"
        value={input.baseURL}
        error={errors.baseURL}
        onChange={(v) => setField("baseURL", v)}
      />
      <Field
        label="API Key"
        placeholder="sk-…（本地端点可留空）"
        value={input.apiKey}
        error={errors.apiKey}
        onChange={(v) => setField("apiKey", v)}
      />
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-fg-muted">
            模型（每行一个，第一项为新建任务的默认回退）
          </span>
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-hover hover:text-fg"
            onClick={addModel}
          >
            添加模型
          </button>
        </div>
        {models.map((model, index) => (
          <div
            key={index}
            className="flex flex-col gap-1"
            data-testid="model-row"
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs text-fg-subtle">
                模型 {index + 1}
                {index === 0 && (
                  <span
                    className="rounded-sm bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent"
                    data-testid="default-model-badge"
                  >
                    默认
                  </span>
                )}
              </span>
              <span className="flex gap-1">
                <button
                  type="button"
                  disabled={index === 0}
                  className="rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-30"
                  onClick={() => moveModel(index, -1)}
                >
                  上移
                </button>
                <button
                  type="button"
                  disabled={index === models.length - 1}
                  className="rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-30"
                  onClick={() => moveModel(index, 1)}
                >
                  下移
                </button>
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-danger-bg hover:text-danger-fg"
                  onClick={() => removeModel(index)}
                >
                  删除
                </button>
              </span>
            </div>
            <input
              value={model}
              placeholder={index === 0 ? "如：glm-4.7" : "追加模型名"}
              aria-label={`模型 ${index + 1}`}
              onChange={(event) => setModelAt(index, event.target.value)}
              className={`rounded border bg-code-bg px-3 py-2 text-fg placeholder:text-fg-subtle ${
                errors.models !== undefined
                  ? "border-danger-fg"
                  : "border-line focus:border-accent"
              } outline-none`}
            />
          </div>
        ))}
        {errors.models !== undefined && (
          <span className="text-xs text-danger-fg">{errors.models}</span>
        )}
      </div>
      <Field
        label="上下文窗口（tokens，可选）"
        placeholder="如：128000；留空按默认 128k 估算（上下文告警阈值 = 窗口 × 80%）"
        value={windowTokensText}
        error={errors.contextWindowTokens}
        onChange={(v) => setWindowTokensText(v)}
      />

      {submitError !== "" && (
        <p className="rounded border border-danger-fg/30 bg-danger-bg px-3 py-2 text-sm text-danger-fg">
          {submitError}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="rounded px-3 py-1.5 text-sm text-fg-muted hover:bg-hover"
          onClick={props.onCancel}
        >
          取消
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded bg-accent px-4 py-1.5 text-sm text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          {saving ? "保存中…" : props.submitLabel}
        </button>
      </div>
    </form>
  );
}

function Field(props: {
  label: string;
  placeholder: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-fg-muted">{props.label}</span>
      <input
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
        className={`rounded border bg-code-bg px-3 py-2 text-fg placeholder:text-fg-subtle ${
          props.error !== undefined
            ? "border-danger-fg"
            : "border-line focus:border-accent"
        } outline-none`}
      />
      {props.error !== undefined && (
        <span className="text-xs text-danger-fg">{props.error}</span>
      )}
    </label>
  );
}
