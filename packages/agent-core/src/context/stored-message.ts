import type { StoredMessage } from "../task/types";

/** 运行、恢复、压缩与 token 估算共用的上下文文本；问答不产生额外用户轮次。 */
export function composeStoredMessageContent(message: StoredMessage): string {
  let content =
    message.role === "compact-summary"
      ? `<compact-summary>\n以下是本会话此前对话历史的压缩摘要：\n${message.content}\n</compact-summary>`
      : message.content;
  if (message.mentions?.length) {
    content += `\n\n以下为该消息 @引用 的工作区文件内容：\n\n${message.mentions.map((mention) => `<attached-file path="${mention.path}">\n${mention.content}\n</attached-file>`).join("\n")}`;
  }
  if (message.questionAnswers?.length) {
    content += `\n\n以下为本轮已提交的用户问答（含子代理来源）：\n<question-answers>\n${JSON.stringify(message.questionAnswers)}\n</question-answers>`;
  }
  return content;
}
