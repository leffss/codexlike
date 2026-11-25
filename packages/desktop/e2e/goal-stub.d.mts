// e2e/goal-stub.mjs 的手写声明：desktop tests/ 的 TS 单测与 typecheck 需要
// （e2e 场景自身是 .mjs，不经 tsc）。与 goal-stub.mjs 的导出保持同步；
// startMockProvider 自 helpers.mjs re-export，此处按本模块使用面声明签名。
import type { IncomingMessage, ServerResponse } from "node:http";

/** 判定结论（spec「完成判定」契约的三字段输出） */
export interface GoalVerdict {
  passed: boolean;
  reason: string;
  nextAction: string;
}

/** 一次模型调用应答携带的真实 usage（票 05：token 预算对账需要确定性的用量） */
export interface StubUsage {
  promptTokens: number;
  completionTokens: number;
}

/** 判定结论应答形态（票 02 解析容错的对象面） */
export type GoalVerdictFormat = "raw" | "code-fence" | "string-wrapped";

/**
 * /chat/completions 应答工具集（骨架 startMockProvider 提供的 ctx）。各收尾类
 * 方法可带 usage：随收尾帧上报；不给则应答不带 usage（任务用量记 0）。
 */
export interface ChatContext {
  port: number;
  send(payload: Record<string, unknown>, usage?: StubUsage): void;
  finishWith(reason: string, usage?: StubUsage): void;
  toolCallRound(
    callId: string,
    name: string,
    args: Record<string, unknown>,
    usage?: StubUsage
  ): void;
  textRound(text: string, usage?: StubUsage): void;
  textChunksRound(chunks: string[], interval?: number, usage?: StubUsage): void;
  respondJson(payload: unknown): void;
  notFound(): void;
}

/** 判定线 ctx：在 ChatContext 之上注入 verdictRound（返回构造文本供断言） */
export type VerdictContext = ChatContext & {
  verdictRound(
    verdict: GoalVerdict,
    format?: GoalVerdictFormat,
    usage?: StubUsage
  ): string;
};

/** 脚本回调的请求状态（index 只数本线请求，从 1 起） */
export interface ChatScriptState {
  body: string;
  index: number;
  port: number;
}

/** mock provider 句柄（server/port/seenBodies/requestCount 同 helpers 骨架） */
export interface MockProviderHandle {
  server: { close(): void };
  port: number;
  seenBodies: string[];
  requestCount(): number;
}

export declare const GOAL_VERIFICATION_MARKER: string;
export declare const GOAL_VERIFICATION_MARKERS: readonly string[];
export declare const GOAL_VERDICT_FORMATS: readonly GoalVerdictFormat[];
export declare function isGoalVerdict(value: unknown): value is GoalVerdict;
export declare function isGoalVerificationRequest(bodyText: string): boolean;
export declare function goalVerdictText(
  verdict: GoalVerdict,
  format?: GoalVerdictFormat
): string;
export declare function startGoalMockProvider(options?: {
  work?: (ctx: ChatContext, state: ChatScriptState) => void;
  verdict?: (ctx: VerdictContext, state: ChatScriptState) => void;
  /** provider 级缺省 usage：两条线每次应答都上报（可按次覆盖）；不给则不上报 */
  usage?: StubUsage;
  isVerdictRequest?: (bodyText: string) => boolean;
  onOther?: (req: IncomingMessage, res: ServerResponse) => boolean | undefined;
}): Promise<MockProviderHandle>;

/** helpers.mjs 骨架工厂（经 goal-stub.mjs re-export；第三参为判定线 options） */
export declare function startMockProvider(
  onChat: (ctx: ChatContext, state: ChatScriptState) => void,
  onOther?: (req: IncomingMessage, res: ServerResponse) => boolean | undefined,
  options?: {
    isVerdictRequest?: (bodyText: string) => boolean;
    onVerdict?: (ctx: ChatContext, state: ChatScriptState) => void;
  }
): Promise<MockProviderHandle>;
