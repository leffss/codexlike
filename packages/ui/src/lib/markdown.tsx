import type { Components } from "react-markdown";

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
