import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import type { UiMessage } from '../lib/session-view';

/** 中栏上部：消息流。用户消息、助手 markdown 流式回复、错误提示卡片。 */
export function MessageStream(props: {
  messages: UiMessage[];
  emptyHint?: ReactNode;
}) {
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto bg-slate-950/40 px-4 py-4"
      data-testid="message-stream"
    >
      {props.messages.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-600">
          <p className="text-sm">消息流为空</p>
          {props.emptyHint}
        </div>
      ) : (
        <ol className="mx-auto flex max-w-3xl flex-col gap-4">
          {props.messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </ol>
      )}
    </div>
  );
}

function MessageBubble(props: { message: UiMessage }) {
  const { message } = props;

  if (message.role === 'user') {
    return (
      <li
        data-testid="message-user"
        className="ml-auto max-w-[85%] rounded-lg bg-sky-800/50 px-3 py-2 text-sm whitespace-pre-wrap text-slate-100"
      >
        {message.content}
      </li>
    );
  }

  if (message.role === 'error') {
    return (
      <li
        data-testid="message-error"
        className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300"
      >
        {message.content}
      </li>
    );
  }

  return (
    <li data-testid="message-assistant" className="max-w-full">
      <div className="markdown rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {message.content}
        </ReactMarkdown>
        {message.streaming === true && (
          <span className="markdown-cursor" aria-label="正在生成" />
        )}
        {message.interrupted === true && (
          <p className="mt-2 text-xs text-amber-400">（已中断，以上为部分回复）</p>
        )}
      </div>
    </li>
  );
}
