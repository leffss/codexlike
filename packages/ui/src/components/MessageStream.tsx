import type { ReactNode } from 'react';

/** 中栏上部：消息流。当前为空态，agent 对接后展示用户消息/回复/工具卡片。 */
export function MessageStream(props: { emptyHint?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-slate-950/40">
      <div className="flex flex-col items-center gap-3 text-slate-600">
        <p className="text-sm">消息流为空</p>
        {props.emptyHint}
      </div>
    </div>
  );
}
