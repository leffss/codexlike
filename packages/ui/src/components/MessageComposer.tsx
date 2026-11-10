import { useState, type KeyboardEvent } from 'react';

import type { ProviderProfile } from '@codexlike/agent-core';

/**
 * 中栏底部：消息输入区。
 * 模型选择器（Provider Profile）对下一条发送的消息生效；
 * 审批模式选择器、斜杠命令与 @文件引用随后续工单接入。
 */
export function MessageComposer(props: {
  profiles: ProviderProfile[];
  selectedProfileId: string;
  onSelectProfile: (id: string) => void;
  onSend: (text: string) => void;
  /** 无会话 / 未选模型 / 流式回复中时禁用发送 */
  disabled: boolean;
  hint: string;
}) {
  const [value, setValue] = useState('');

  function submit() {
    const text = value.trim();
    if (text === '' || props.disabled) {
      return;
    }
    props.onSend(text);
    setValue('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter 发送，Shift+Enter 换行
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="border-t border-slate-800 bg-slate-900/60 p-3">
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <select
          data-testid="profile-select"
          value={props.selectedProfileId}
          onChange={(event) => props.onSelectProfile(event.target.value)}
          className="h-11 shrink-0 rounded-lg border border-slate-700 bg-slate-950/70 px-2 text-xs text-slate-200"
          title="模型（Provider Profile）：对下一条消息生效"
        >
          {props.profiles.length === 0 && <option value="">未配置模型</option>}
          {props.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} · {profile.model}
            </option>
          ))}
        </select>
        <textarea
          data-testid="composer-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={props.hint}
          rows={2}
          className="min-h-11 flex-1 resize-none rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
        />
        <button
          type="submit"
          data-testid="composer-send"
          disabled={props.disabled}
          className="rounded-lg bg-sky-700 px-4 py-2 text-sm text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          发送
        </button>
      </form>
    </div>
  );
}
