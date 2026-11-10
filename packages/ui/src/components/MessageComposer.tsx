import { useState } from 'react';

/**
 * 中栏底部：输入框骨架。
 * 后续工单接入：模型选择器、审批模式选择器、斜杠命令与 @文件引用。
 */
export function MessageComposer(props: { hint: string }) {
  const [value, setValue] = useState('');

  return (
    <div className="border-t border-slate-800 bg-slate-900/60 p-3">
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => event.preventDefault()}
      >
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={props.hint}
          disabled
          rows={2}
          className="min-h-11 flex-1 resize-none rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 disabled:cursor-not-allowed"
        />
        <button
          type="submit"
          disabled
          className="rounded-lg bg-sky-700/50 px-4 py-2 text-sm text-slate-400 disabled:cursor-not-allowed"
        >
          发送
        </button>
      </form>
    </div>
  );
}
