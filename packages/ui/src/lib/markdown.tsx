import type { Components } from "react-markdown";

/**
 * markdown 渲染的布局层覆盖（票 05）：宽表格包进横向滚动容器，
 * 滚动内聚在表格自身、不撑破消息流内容列（spec 用户故事 34）；
 * 代码块 pre 的内聚滚动见 styles.css 的 .markdown pre。
 * 仅做布局包裹，不改变 markdown 的渲染语义。
 */
export const markdownComponents: Components = {
  table: ({ node: _node, ...rest }) => (
    <div className="overflow-x-auto">
      <table {...rest} />
    </div>
  ),
};
