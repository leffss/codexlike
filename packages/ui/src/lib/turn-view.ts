import type {
  MessageSegment,
  ToolCallSegment,
  UserSegment,
} from "./session-view";

/**
 * 轮次聚合与轮内切分（ADR 0011 呈现分层第三层，GLOSSARY「轮次」「已工作折叠区」）。
 *
 * 渲染三层中的后两层在此纯函数完成：按 turnId 把时序消息段序列聚成轮，
 * 轮内以「最终正文」（轮内最后一段正文；无正文轮全部过程入折叠区）为界
 * 切成已工作折叠区（history）与跟随区（following）；数据层只提供
 * 「可折叠的事实」（段类型、流态、中断/错误标记、at 时刻），开合默认值
 * 与强制展开规则在这里推导，用户手动开合是渲染层内存态（不进数据层）。
 */

/** 轮次呈现视图：分组与切分的结果（折叠区开合的默认值，不是记忆态） */
export interface TurnView {
  /** 轮次标签（分组 key 与折叠记忆 key） */
  turnId: string;
  /** 轮内用户消息段（轮次起点，始终显示；兜底轮为 null） */
  user: UserSegment | null;
  /** 已工作折叠区内的过程段（最终正文之前；无正文轮=全部过程段） */
  history: MessageSegment[];
  /** 跟随显示的段（最终正文及其之后；无正文轮为空） */
  following: MessageSegment[];
  /**
   * 折叠区默认展开：运行中的轮与中断、失败终态的轮强制展开；
   * 正常完成的轮默认收起（长会话历史只剩各轮最终正文）。
   */
  historyDefaultOpen: boolean;
  /** 轮仍在运行（流态正文/思考、运行中工具卡或子代理任一成立） */
  running: boolean;
  /** 已工作时长（毫秒）：轮内段时间线极差（at → endedAt/completedAt）；任一段缺时间数据为 null */
  durationMs: number | null;
  /** 轮开始时刻（毫秒，段 at 最小值）：运行中工时跳动的基准；缺时间数据为 null */
  startedAtMs: number | null;
}

/** 段处于流态或运行中（轮次"运行中"判据；流式过程实时可见） */
function isSegmentRunning(segment: MessageSegment): boolean {
  if (segment.kind === "assistant" || segment.kind === "thinking")
    return segment.streaming === true;
  if (segment.kind === "tool-call") return segment.running === true;
  if (segment.kind === "subagent") return segment.state !== "done";
  return false;
}

/** 轮次终态为中断或失败（过程强制展开，便于看到失败前发生了什么） */
function isTurnFailed(segments: MessageSegment[]): boolean {
  return segments.some(
    (segment) =>
      (segment.kind === "assistant" && segment.interrupted === true) ||
      segment.kind === "error"
  );
}

/**
 * 进「已工作折叠区」的过程段类型：agent 的工作过程（思考、中间正文、
 * 工具调用、子代理）。交互记录/错误/状态/压缩摘要是用户可见节点
 * （审批决定、失败提示、本地命令反馈），穿透折叠区保持可见，
 * 按相对顺序显示在折叠区之后。
 */
const HISTORY_KINDS = new Set([
  "thinking",
  "assistant",
  "tool-call",
  "subagent",
]);

/**
 * 时序消息段序列 → 轮次视图列表。
 * 分组按 turnId 连续聚簇（段序即事件序，轮内段天然相邻）；
 * 用户消息段是轮次起点但不进折叠区。
 *
 * lastTurnRunning：宿主执行态（会话 activity.running）。段级运行标记在
 * 工具回填后、下一段事件前的间隙会全部静止，宿主态补上这个缺口——
 * 最后一轮在宿主仍执行期间保持强制展开，不闪收。
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
    const process = cluster.filter((segment) => segment.kind !== "user");
    // 最终正文 = 轮内最后一段正文（切分锚点）
    let finalTextIndex = -1;
    for (let i = process.length - 1; i >= 0; i--) {
      if (process[i]?.kind === "assistant") {
        finalTextIndex = i;
        break;
      }
    }
    const beforeFinal =
      finalTextIndex < 0 ? process : process.slice(0, finalTextIndex);
    const history = beforeFinal.filter((segment) =>
      HISTORY_KINDS.has(segment.kind)
    );
    // 穿透段（交互/错误/状态/摘要）按相对顺序跟随显示，再接最终正文起
    const passthrough = beforeFinal.filter(
      (segment) => !HISTORY_KINDS.has(segment.kind)
    );
    const following =
      finalTextIndex < 0
        ? passthrough
        : [...passthrough, ...process.slice(finalTextIndex)];
    const running =
      cluster.some(isSegmentRunning) ||
      (options.lastTurnRunning === true && index === clusters.length - 1);
    const { durationMs, startedAtMs } = turnDuration(cluster);
    return {
      turnId: cluster[0]?.turnId ?? "",
      user,
      history,
      following,
      historyDefaultOpen: running || isTurnFailed(cluster),
      running,
      durationMs,
      startedAtMs,
    };
  });
}

/**
 * 工时：轮内段时间线极差——起点取段 at 最小值，终点取各段
 * at / endedAt / completedAt 最大值（流式正文/思考的时长计入工时，
 * 终点不再停在最后一个事件建段时刻）；任一段缺 at 则不可知
 * （呈现层省略数字）。
 */
function turnDuration(cluster: MessageSegment[]): {
  durationMs: number | null;
  startedAtMs: number | null;
} {
  let min: number | undefined;
  let max: number | undefined;
  for (const segment of cluster) {
    const at = segment.at;
    if (at === undefined) return { durationMs: null, startedAtMs: null };
    if (min === undefined || at < min) min = at;
    const end = segmentEnd(segment);
    if (end !== undefined && (max === undefined || end > max)) max = end;
    if (max === undefined || at > max) max = at;
  }
  if (min === undefined || max === undefined) {
    return { durationMs: null, startedAtMs: null };
  }
  return { durationMs: Math.max(0, max - min), startedAtMs: min };
}

/** 段时间线终点：收敛/完成时刻优先，缺省回退段建立时刻 */
function segmentEnd(segment: MessageSegment): number | undefined {
  if (segment.kind === "assistant") {
    return segment.completedAt ?? segment.endedAt ?? segment.at;
  }
  if (segment.kind === "thinking") {
    return segment.endedAt ?? segment.at;
  }
  if (segment.kind === "tool-call") {
    return segment.endedAt ?? segment.at;
  }
  return segment.at;
}

/**
 * 共享时长文案（工具卡耗时与「已工作 N 秒」工时同源）：满分钟统一
 * 「N 分 [M 秒]」（秒四舍五入）；60 秒内的秒位呈现按 tenths 切换——
 * true 保留一位小数（工具卡耗时），false 四舍五入整数（工时摘要）。
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

/** 「已工作 N 秒」摘要行的工时文案（秒四舍五入；满分钟分解为分+秒） */
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
  /** 非工具过程段（思考/中间正文/子代理）：原样透传，保持时序不丢段 */
  | { kind: "passthrough"; segment: MessageSegment };

/**
 * 折叠区过程序列 → 连续同类工具统计分组（spec 用户故事 29：「Read × 5」）。
 * 只有相邻、同名且已完成的工具卡合并为组（组头计数，展开仍由原卡片渲染）；
 * 运行中的工具卡实时可见，不进组；非工具段原样透传并打断连续性。
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
    if (segment.kind === "tool-call" && segment.running !== true) {
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
      // 运行中的工具卡：实时可见，不参与分组
      items.push({ kind: "single", segment });
    } else {
      items.push({ kind: "passthrough", segment });
    }
  }
  flush();
  return items;
}
