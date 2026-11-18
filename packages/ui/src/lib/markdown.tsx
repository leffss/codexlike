import { createContext, memo, useContext, useLayoutEffect } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { useThrottledText } from "./use-throttled-text";

/** 局部正文晚 commit 时通知所属消息流；不向事件层传播节流状态。 */
export const ContentCommitContext = createContext<(() => void) | undefined>(
  undefined
);

/** 流式只节流这一块的显示，稳定正文仍交由 memo 叶节点解析。 */
export function StreamingMarkdownContent(props: {
  content: string;
  streaming: boolean;
}) {
  const content = useThrottledText(props.content, props.streaming);
  const onCommit = useContext(ContentCommitContext);
  useLayoutEffect(() => onCommit?.(), [content, onCommit]);
  return <MarkdownContent content={content} />;
}

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

/** 仅以正文字符串决定解析工作；父更新、计时与新建段对象不使历史重解析。 */
export const MarkdownContent = memo(function MarkdownContent(props: {
  content: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={markdownComponents}
    >
      {props.content}
    </ReactMarkdown>
  );
});

/**
 * markdown 渲染的布局层覆盖（票 05）：宽表格包进横向滚动容器，
 * 滚动内聚在表格自身、不撑破消息流内容列（spec 用户故事 34）；
 * 代码块 pre 的内聚滚动见 styles.css 的 .markdown pre。
 * 链接统一声明新上下文，由桌面宿主负责外部打开；UI 不依赖 Electron。
 */
export const markdownComponents: Components = {
  a: ({ node: _node, href, ...rest }) => {
    // href 已经过 ReactMarkdown 默认安全转换，不从原始 node 恢复被过滤的 URL。
    if (href?.startsWith("#")) {
      return <a {...rest} href={href} />;
    }
    if (href !== undefined && /^https?:\/\//i.test(href)) {
      try {
        const url = new URL(href);
        if (url.protocol === "http:" || url.protocol === "https:") {
          return (
            <a
              {...rest}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
            />
          );
        }
      } catch {
        // 非法 URL 与不支持的目标一样降级，保留 children、title 与可访问性属性。
      }
    }
    return <span {...rest} />;
  },
  table: ({ node: _node, ...rest }) => (
    <div className="overflow-x-auto">
      <table {...rest} />
    </div>
  ),
};
