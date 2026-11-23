// 票 01（goal-mode）：e2e stub provider「完成判定」脚本化响应线。
// 目标模式（ADR 0035）的 e2e 场景需要在同一个 mock provider 上脚本化两条
// 响应线：「工作轮回复」（既有能力，streamText 带 tools）与「完成判定回复」
// （本模块新增：每轮回合结束后的无工具模型调用，输出 {passed, reason, nextAction}）。
// 两条线按请求特征分流、index 分账互不串线——判定请求不消耗工作轮脚本序号，
// 反之亦然，同一场景可分别驱动。
//
// 票 02 对接契约（判定请求识别特征，与 spec「完成判定」节对齐）：
// 1. 请求体不含非空 tools 数组（工作轮 streamText 必带 tools；判定是无工具调用，
//    generateText 或不带 tools 的 streamText 均满足）；
// 2. 请求体含判定 prompt 标记之一：英文稳定标记 `[goal-verification]`（票 02
//    构造判定 prompt 时务必在 system 消息携带，作为机器可识别锚）或中文
//    「完成判定」措辞（容错）。
// 特征不满足时（如提交消息生成、compact 摘要等既有非流式请求）一律走工作轮线，
// 既有场景行为不变；场景可用 isVerdictRequest 注入整体替换识别逻辑。
import { startMockProvider } from "./helpers.mjs";

// 一站式出口：双线场景从本模块拿全 stub API（含骨架工厂，便于只关心
// 工作轮线的场景沿用既有签名；goal-stub.d.mts 中有对应手写声明）。
export { startMockProvider };

/** 判定 prompt 的机器可识别锚：票 02 的判定 system prompt 必须携带（建议首部） */
export const GOAL_VERIFICATION_MARKER = "[goal-verification]";

/** 判定请求的 prompt 标记集：英文稳定标记 + 中文「完成判定」容错措辞 */
export const GOAL_VERIFICATION_MARKERS = [GOAL_VERIFICATION_MARKER, "完成判定"];

/** 判定结论三字段：passed / reason / nextAction（spec 完成判定契约） */
export function isGoalVerdict(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "passed" in value &&
    "reason" in value &&
    "nextAction" in value
  );
}

/** 非空 tools 数组的宽松文本特征（streamText 工作轮请求必含；空数组 [] 视为无工具） */
const NON_EMPTY_TOOLS = /"tools"\s*:\s*\[\s*[^\s\]]/;

/**
 * 完成判定请求的默认识别：无工具（无 tools 字段或空数组）+ 含判定 prompt 标记。
 * @param {string} bodyText /chat/completions 请求体原文
 * @returns {boolean}
 */
export function isGoalVerificationRequest(bodyText) {
  if (!GOAL_VERIFICATION_MARKERS.some((marker) => bodyText.includes(marker))) {
    return false;
  }
  return !NON_EMPTY_TOOLS.test(bodyText);
}

/** 判定结论应答形态（票 02 解析容错的对象面）：裸 JSON / 代码围栏包裹 / 字符串字面量包裹 */
export const GOAL_VERDICT_FORMATS = ["raw", "code-fence", "string-wrapped"];

/**
 * 构造判定结论文本：模型视角下 {passed, reason, nextAction} 的各种包裹形态。
 * - raw：裸 JSON（理想输出）
 * - code-fence：```json 围栏包裹（真实模型常见）
 * - string-wrapped：整体再套一层 JSON 字符串字面量（带引号转义的双重编码）
 * @param {{ passed: boolean, reason: string, nextAction: string }} verdict
 * @param {(typeof GOAL_VERDICT_FORMATS)[number]} format
 * @returns {string}
 */
export function goalVerdictText(verdict, format = "raw") {
  const raw = JSON.stringify(verdict);
  if (format === "code-fence") return `\`\`\`json\n${raw}\n\`\`\``;
  if (format === "string-wrapped") return JSON.stringify(raw);
  return raw;
}

/** 非流式 chat completion 应答（content 携带判定文本） */
function verdictCompletion(text) {
  return {
    id: "chatcmpl-e2e-goal-verdict",
    object: "chat.completion",
    created: 0,
    model: "mock-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
  };
}

/**
 * 给判定线 ctx 注入 verdictRound：按请求体 stream 字段自适应应答——
 * 流式走 SSE 文本帧（不带 tools 的 streamText 判定路径），非流式走
 * chat completion JSON（generateText 判定路径），两条路径票 02 任选皆可踩。
 * 返回构造的判定文本，供场景直接断言。
 */
function enhanceVerdictContext(ctx, body) {
  return {
    ...ctx,
    verdictRound(verdict, format = "raw") {
      const text = goalVerdictText(verdict, format);
      if (/"stream"\s*:\s*true/.test(body)) ctx.textRound(text);
      else ctx.respondJson(verdictCompletion(text));
      return text;
    },
  };
}

/**
 * 双线脚本化 mock provider（目标模式 e2e 的标准入口）：
 * - work(ctx, { body, index })：工作轮应答（契约同 startMockProvider 的 onChat，
 *   index 只数工作轮请求，从 1 起；缺省回占位文本，漏配立即可见）；
 * - verdict(ctx, { body, index })：判定应答（index 只数判定请求，从 1 起；
 *   ctx 额外携带 verdictRound(verdict, format)；缺省回未通过占位结论）；
 * - isVerdictRequest：识别特征注入，缺省 isGoalVerificationRequest；
 * - onOther：透传 startMockProvider 的非 chat 路径处理器。
 * 返回值同 startMockProvider（server/port/seenBodies/requestCount）。
 */
export async function startGoalMockProvider({
  work,
  verdict,
  isVerdictRequest = isGoalVerificationRequest,
  onOther,
} = {}) {
  return startMockProvider(
    work ??
      ((ctx) => {
        ctx.textRound("（工作轮未脚本化）");
      }),
    onOther,
    {
      isVerdictRequest,
      onVerdict(ctx, { body, index }) {
        const enhanced = enhanceVerdictContext(ctx, body);
        if (verdict === undefined) {
          enhanced.verdictRound({
            passed: false,
            reason: "判定线未脚本化",
            nextAction: "请在场景配置 verdict 脚本",
          });
          return;
        }
        verdict(enhanced, { body, index });
      },
    }
  );
}
