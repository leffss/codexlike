/**
 * 折叠卡摘要行（呈现层纯函数）：思考卡、中间正文卡等收起态卡片上的一行
 * 摘要。取首个非空行、行内空白压平为单空格、按码点计数超长截断加省略号；
 * 内容为空（或全空白）返回空串，由调用方回退到占位文案。
 */

/** 摘要行最大长度（码点数）；超出截断加省略号 */
const SUMMARY_MAX_CHARS = 60;

export function thinkingSummary(
  content: string,
  maxChars: number = SUMMARY_MAX_CHARS
): string {
  let firstLine = "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") {
      firstLine = trimmed;
      break;
    }
  }
  const flat = firstLine.replace(/\s+/g, " ");
  // 按 Unicode 码点截断（Array.from），不在代理对（emoji 等）中间切断
  const chars = Array.from(flat);
  if (chars.length <= maxChars) return flat;
  return `${chars.slice(0, maxChars).join("")}…`;
}
