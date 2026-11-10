import { useState } from 'react';

import {
  validateProviderProfile,
  type ProviderProfileErrors,
  type ProviderProfileInput,
} from '@codexlike/agent-core';

const EMPTY_INPUT: ProviderProfileInput = {
  name: '',
  baseURL: '',
  apiKey: '',
  model: '',
};

/** 设置页的 Provider Profile 表单：新建/编辑共用，校验复用 agent-core 规则 */
export function ProviderProfileForm(props: {
  initial?: ProviderProfileInput;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (input: ProviderProfileInput) => Promise<void>;
}) {
  const [input, setInput] = useState<ProviderProfileInput>(
    props.initial ?? EMPTY_INPUT,
  );
  const [errors, setErrors] = useState<ProviderProfileErrors>({});
  const [submitError, setSubmitError] = useState('');
  const [saving, setSaving] = useState(false);

  function setField(field: keyof ProviderProfileInput, value: string) {
    setInput((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitError('');
    const validation = validateProviderProfile(input);
    setErrors(validation);
    if (Object.values(validation).some((message) => message !== undefined)) {
      return;
    }
    setSaving(true);
    try {
      await props.onSubmit(input);
    } catch (error) {
      // 主进程 IPC 拒绝（校验失败 / safeStorage 不可用等）的中文消息直接展示
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-4"
      onSubmit={(handleSubmit)}
    >
      <Field
        label="名称"
        placeholder="如：GLM、DeepSeek"
        value={input.name}
        error={errors.name}
        onChange={(v) => setField('name', v)}
      />
      <Field
        label="baseURL"
        placeholder="https://open.bigmodel.cn/api/paas/v4"
        value={input.baseURL}
        error={errors.baseURL}
        onChange={(v) => setField('baseURL', v)}
      />
      <Field
        label="API Key"
        placeholder="sk-…（本地端点可留空）"
        value={input.apiKey}
        error={errors.apiKey}
        onChange={(v) => setField('apiKey', v)}
      />
      <Field
        label="模型"
        placeholder="如：glm-4.7"
        value={input.model}
        error={errors.model}
        onChange={(v) => setField('model', v)}
      />

      {submitError !== '' && (
        <p className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-400">
          {submitError}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="rounded px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800"
          onClick={props.onCancel}
        >
          取消
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded bg-sky-700 px-4 py-1.5 text-sm text-white hover:bg-sky-600 disabled:opacity-50"
        >
          {saving ? '保存中…' : props.submitLabel}
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
      <span className="text-slate-400">{props.label}</span>
      <input
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
        className={`rounded border bg-slate-950/70 px-3 py-2 text-slate-200 placeholder:text-slate-600 ${
          props.error !== undefined
            ? 'border-red-700'
            : 'border-slate-700 focus:border-sky-600'
        } outline-none`}
      />
      {props.error !== undefined && (
        <span className="text-xs text-red-400">{props.error}</span>
      )}
    </label>
  );
}
