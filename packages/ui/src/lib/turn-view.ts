import { PLAN_TOOL_NAME } from "./plan-view";
import { isTerminalSubagentState } from "./subagent-status";
import type { MessageSegment, ToolCallSegment, UserSegment } from "./task-view";
import {
  TERMINAL_READ_TOOL,
  terminalReadSessionId,
} from "./terminal-read-view";

/**
 * 轮次聚合（ADR 0011 呈现分层第三层、ADR 0015 逐段呈现，GLOSSARY「轮次」「过程段」）。
 *
 * 渲染三层中的后两层在此纯函数完成：按 turnId 把时序消息段序列聚成轮，
 * 轮内段保持事件原序平铺（过程段逐段自带工时：活动段默认展开、完成后
 * 自动收起——开合默认值由各段卡片组件推导，用户手动开合是渲染层内存态，
 * 不进数据层，见 collapse-memory）。
 */

/** 轮次呈现视图：分组结果（轮内段保持事件原序，呈现层不再重排） */
export interface TurnView {
  /** 轮次标签（分组 key） */
  turnId: string;
  /** 轮内用户消息段（轮次起点，始终显示；兜底轮为 null） */
  user: UserSegment | null;
  /** 轮内全部非用户消息段（时序原序：过程段、穿透段、最终正文） */
  segments: MessageSegment[];
  /** 轮仍在运行（流态正文/思考、运行中工具卡或子代理任一成立） */
  running: boolean;
  /** 轮内最后一段正文（最终正文）的段 id：操作栏只挂这一段，其余正文段是过程段 */
  finalAssistantId: string | null;
}

/** 段处于流态或运行中（轮次"运行中"判据；流式过程实时可见） */
function isSegmentRunning(segment: MessageSegment): boolean {
  if (segment.kind === "assistant" || segment.kind === "thinking")
    return segment.streaming === true;
  if (segment.kind === "tool-call") return segment.running === true;
  if (segment.kind === "subagent")
    return !isTerminalSubagentState(segment.state);
  return false;
}

/**
 * 时序消息段序列 → 轮次视图列表。
 * 分组按 turnId 连续聚簇（段序即事件序，轮内段天然相邻）；
 * 用户消息段是轮次起点但不是轮内成员（始终单独呈现）。
 *
 * lastTurnRunning：宿主执行态（任务 activity.running）。段级运行标记在
 * 工具回填后、下一段事件前的间隙会全部静止，宿主态补上这个缺口——
 * 最后一轮在宿主仍执行期间保持运行态，操作栏不提前出现。
 */
export function groupTurns(
  segments: MessageSegment[],
  options: { lastTurnRunning?: boolean } = {}
): TurnView[] {
  const clusters: MessageSegment[][] = [];
  for (const segment of segments) {
    const last = clusters[clusters.length - 1];
    if (last !== undefined && last[0]?.turnId === segment.turnId) {
      last.push(segment);
    } else {
      clusters.push([segment]);
    }
  }
  return clusters.map((cluster, index) => {
    const user = cluster.find((segment) => segment.kind === "user") ?? null;
    // 最终正文 = 轮内最后一段正文（操作栏锚点；无正文轮为 null）
    let finalAssistantId: string | null = null;
    for (const segment of cluster) {
      if (segment.kind === "assistant") finalAssistantId = segment.id;
    }
    const running =
      cluster.some(isSegmentRunning) ||
      (options.lastTurnRunning === true && index === clusters.length - 1);
    return {
      turnId: cluster[0]?.turnId ?? "",
      user,
      segments: cluster.filter((segment) => segment.kind !== "user"),
      running,
      finalAssistantId,
    };
  });
}

/**
 * 共享时长文案（各段卡耗时与底部运行行工时同源）：满分钟统一
 * 「N 分 [M 秒]」（秒四舍五入）；60 秒内的秒位呈现按 tenths 切换——
 * true 保留一位小数（工具卡耗时），false 四舍五入整数（运行行工时）。
 */
export function formatDurationCn(durationMs: number, tenths = false): string {
  if (tenths && durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(1)} 秒`;
  }
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

/** 底部「运行中」运行行的工时文案（秒四舍五入；满分钟分解为分+秒） */
export function formatWorkDuration(durationMs: number): string {
  return formatDurationCn(durationMs);
}

/** 连续同类工具统计分组的序列条目 */
export type ToolSequenceItem =
  | { kind: "single"; segment: ToolCallSegment }
  | {
      kind: "group";
      toolName: string;
      segments: ToolCallSegment[];
      /** 组内含失败卡（组头提示，失败详情展开原卡可查） */
      hasError: boolean;
    }
  /** 非工具段（思考/中间正文/子代理/交互/错误/状态）：原样透传，保持时序不丢段 */
  | { kind: "passthrough"; segment: MessageSegment }
  /**
   * terminal_read 轮内锚点（ADR 0033「消息流 read 锚点」）：一轮内对同一
   * 会话的历次读取（含跨思考段）归并一项，calls 保持时序原序、锚点位置 =
   * 首个 read 的时序位置；历次详情展开锚点行可见（数据层段不变，仅呈现收敛）
   */
  | TerminalReadItem;

/**
 * terminal_read 轮内锚点视图项：sessionId 聚合键 + 历次调用段（时序原序，
 * 单一事实源——计数、最新增量、历次列表均由 calls 现场派生）
 */
export interface TerminalReadItem {
  kind: "terminal-read";
  sessionId: string;
  calls: ToolCallSegment[];
}

/**
 * 轮内段序列 → 连续同类工具统计分组（spec 用户故事 29：「Read × 5」）。
 * 只有相邻、同名且已完成的工具卡合并为组（组头计数，展开仍由原卡片渲染）；
 * 运行中的工具卡实时可见，不进组；非工具段原样透传并打断连续性。
 * 工作计划（update_plan，ADR 0016）排除出分组：相邻两次计划更新各有独立
 * 标记行语义，折成「update_plan × 2」组头会吞掉单次更新摘要。
 */
export function groupConsecutiveTools(
  segments: MessageSegment[]
): ToolSequenceItem[] {
  const items: ToolSequenceItem[] = [];
  let pending: ToolCallSegment[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    if (pending.length === 1) {
      const [segment] = pending;
      if (segment !== undefined) items.push({ kind: "single", segment });
    } else {
      const [first] = pending;
      if (first !== undefined) {
        items.push({
          kind: "group",
          toolName: first.toolName,
          segments: pending,
          hasError: pending.some((segment) => segment.isError),
        });
      }
    }
    pending = [];
  };

  for (const segment of segments) {
    if (
      segment.kind === "tool-call" &&
      segment.running !== true &&
      segment.toolName !== PLAN_TOOL_NAME
    ) {
      // 同名相邻的已完成工具卡累计成组；异名先结算前一组
      if (pending[0]?.toolName === segment.toolName) {
        pending.push(segment);
      } else {
        flush();
        pending.push(segment);
      }
      continue;
    }
    flush();
    if (segment.kind === "tool-call") {
      // 运行中或计划更新（各自保持单卡/单行实时可见）：不参与分组
      items.push({ kind: "single", segment });
    } else {
      items.push({ kind: "passthrough", segment });
    }
  }
  flush();
  return items;
}

/**
 * terminal_read 轮内锚点聚合（ADR 0033「消息流 read 锚点」）：分组序列里
 * 同一会话的全部读取调用（single 与 group 形态均展开、跨 passthrough 归并）
 * 收敛为一个 terminal-read 锚点项，位置 = 首个 read 的时序位置；其余段
 * 原样透传保持时序。参数畸形（sessionId 解析失败）的 read 调用退回原卡，
 * 呈现不丢段。无 read 调用时原样返回。
 */
export function foldTerminalReads(
  items: ToolSequenceItem[]
): ToolSequenceItem[] {
  // 第一遍：按会话收集历次调用（时序原序）；无任何 read 时免第二遍
  const callsBySession = new Map<string, ToolCallSegment[]>();
  const collect = (call: ToolCallSegment): void => {
    const sessionId = terminalReadSessionId(call);
    if (sessionId === undefined) return;
    const list = callsBySession.get(sessionId);
    if (list === undefined) callsBySession.set(sessionId, [call]);
    else list.push(call);
  };
  for (const item of items) {
    if (
      item.kind === "single" &&
      item.segment.toolName === TERMINAL_READ_TOOL
    ) {
      collect(item.segment);
    } else if (item.kind === "group" && item.toolName === TERMINAL_READ_TOOL) {
      for (const segment of item.segments) collect(segment);
    }
  }
  if (callsBySession.size === 0) return items;

  // 第二遍：read 段所在项的位置放锚点（item 内逐段判定——group 项可能含
  // 多个会话的调用，各会话锚点按段序依次落位）；已锚定会话的后续项移除；
  // 参数畸形的段退回原卡呈现（段序保真：畸形卡与锚点按原时序穿插）
  const anchored = new Set<string>();
  const output: ToolSequenceItem[] = [];
  for (const item of items) {
    const readCalls: ToolCallSegment[] =
      item.kind === "single" && item.segment.toolName === TERMINAL_READ_TOOL
        ? [item.segment]
        : item.kind === "group" && item.toolName === TERMINAL_READ_TOOL
          ? item.segments
          : [];
    if (readCalls.length === 0) {
      output.push(item);
      continue;
    }
    for (const call of readCalls) {
      const sessionId = terminalReadSessionId(call);
      if (sessionId === undefined) {
        output.push({ kind: "single", segment: call });
        continue;
      }
      if (anchored.has(sessionId)) continue;
      anchored.add(sessionId);
      const calls = callsBySession.get(sessionId) ?? [];
      if (calls.length > 0) {
        output.push({ kind: "terminal-read", sessionId, calls });
      }
    }
  }
  return output;
}
