import { useEffect, useState } from 'react';

import { MessageComposer } from '../components/MessageComposer';
import { MessageStream } from '../components/MessageStream';
import { SessionSidebar } from '../components/SessionSidebar';

/**
 * 主界面：空三栏布局（会话列表 / 消息流 / 输入框）。
 * 会话与 agent 循环在后续工单接入，此处为骨架与空态。
 */
export function WorkspacePage(props: {
  onOpenSettings: () => void;
}) {
  const [hasProvider, setHasProvider] = useState<boolean | null>(null);

  useEffect(() => {
    void window.codexlike.providerProfiles
      .list()
      .then((profiles) => setHasProvider(profiles.length > 0));
  }, []);

  const composerHint =
    hasProvider === null
      ? '正在加载配置…'
      : hasProvider
        ? '输入消息，让 agent 开始工作（会话功能即将开放）'
        : '尚未配置 Provider Profile，请先前往设置页';

  return (
    <div className="flex h-full">
      <SessionSidebar />
      <section className="flex min-w-0 flex-1 flex-col">
        <MessageStream
          emptyHint={
            hasProvider ? undefined : (
              <button
                type="button"
                className="rounded border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-sky-600 hover:text-sky-400"
                onClick={props.onOpenSettings}
              >
                前往设置配置 Provider Profile
              </button>
            )
          }
        />
        <MessageComposer hint={composerHint} />
      </section>
    </div>
  );
}
