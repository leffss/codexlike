/**
 * token 用量估算（纯函数，浏览器安全）。
 * /status 显示当前上下文用量、工单 08 的 compact 复用同一估算——稳定接口，勿随意改动规则。
 *
 * 近似规则（混合中英文的经验折中）：
 * - CJK 字符（含全角标点）约 1.5 字符/token；
 * - 其余字符约 4 字符/token；
 * - 两组相加后向上取整。
 */
const CJK_PATTERN = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

export function estimateTokens(text: string): number {
  if (text === '') {
    return 0;
  }
  const cjk = (text.match(CJK_PATTERN) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 4);
}
