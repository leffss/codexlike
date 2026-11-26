import { COLLAPSE_TITLE_BADGE_CLASS } from "../lib/collapse-card";
import { useCollapseState } from "../lib/collapse-memory";
import type { ToolSequenceItem } from "../lib/turn-view";
import { formatDurationCn } from "../lib/turn-view";

import { DisclosureArrow } from "./DisclosureArrow";
import { ToolCallCard } from "./ToolCallCard";

/**
 * 同名连续工具组（spec 用户故事 29）：组头显示类别与计数
 * （如「read_file × 3」，含失败卡时提示），展开仍由原卡片渲染；
 * 组默认收起（过程区不被重复卡片淹没），开合同样按键记忆。
 * 自 MessageStream 抽出共用（子代理详情工具调用与主代理同款呈现，
 * 2026-11-19 子代理详情呈现对齐轮）：抽独立模块而非互相引用——
 * MessageStream → SubagentStreamMarker → SubagentRailPanel 已成链，
 * 反向 import 会造成渲染循环。
 */
export function ToolGroupView(props: {
  item: Extract<ToolSequenceItem, { kind: "group" }>;
}) {
  const { item } = props;
  const first = item.segments[0];
  const last = item.segments[item.segments.length - 1];
  const { open, toggle } = useCollapseState(
    `tool-group-${first?.id ?? ""}`,
    false
  );
  // 组头耗时汇总：首段开始 → 末段结束的时间线跨度；组内任一卡缺打点则省略
  const groupSpanMs =
    first?.startedAt !== undefined && last?.endedAt !== undefined
      ? last.endedAt - first.startedAt
      : null;
  return (
    <li
      data-testid="tool-call-group"
      data-tool-name={item.toolName}
      data-count={item.segments.length}
    >
      <button
        type="button"
        data-testid="tool-call-group-toggle"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-lg bg-surface-muted px-3.5 py-[9px] text-left text-xs hover:bg-hover"
      >
        <DisclosureArrow open={open} />
        <span
          data-testid="tool-call-group-name"
          className={COLLAPSE_TITLE_BADGE_CLASS}
        >
          {item.toolName}
        </span>
        <span className="text-fg-muted">× {item.segments.length}</span>
        {item.hasError && (
          <span data-testid="tool-call-group-error" className="text-danger-fg">
            含失败
          </span>
        )}
        {groupSpanMs !== null && (
          <span
            data-testid="tool-call-group-duration"
            className="ml-auto shrink-0 font-mono text-xs text-fg-subtle"
          >
            {formatDurationCn(groupSpanMs)}
          </span>
        )}
      </button>
      {open && (
        <ol
          data-testid="tool-call-group-items"
          // 成员卡与组头左对齐：与过程段同一对齐规则（贴齐内容列边界）
          className="mt-2 flex flex-col gap-2"
        >
          {item.segments.map((call) => (
            <ToolCallCard key={call.id} call={call} />
          ))}
        </ol>
      )}
    </li>
  );
}
