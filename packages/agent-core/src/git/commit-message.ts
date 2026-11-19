import { generateText, type LanguageModel, type LanguageModelUsage } from "ai";

import type { StoredMessage } from "../task/types";

/**
 * 一键 commit 的消息生成（spec「git 集成」）：commit 消息默认由模型按任务内容生成，
 * 用户在面板中可编辑。走一次**不发工具**的 LLM 请求（generateText，纯文本往返）。
 */

/** 进入 prompt 的消息条数上限（取最近 N 条） */
const MAX_MESSAGES = 20;
/** 单条消息进入 prompt 的字符上限 */
const MAX_MESSAGE_CHARS = 400;
/** 变更文件列表上限（防巨大变更把 prompt 撑爆） */
const MAX_FILES = 50;

/** 组装提交消息生成的 prompt（纯函数，导出可测） */
export function buildCommitMessagePrompt(
  messages: Pick<StoredMessage, "role" | "content">[],
  changedFiles: string[]
): string {
  // error 是给用户看的中文提示，不属于任务内容；只取最近 20 条、每条截 400 字符
  const recent = messages
    .filter((message) => message.role !== "error")
    .slice(-MAX_MESSAGES)
    .map(
      (message) =>
        `${message.role === "user" ? "用户" : "助手"}：${message.content.slice(0, MAX_MESSAGE_CHARS)}`
    )
    .join("\n");
  const files = changedFiles
    .slice(0, MAX_FILES)
    .map((path) => `- ${path}`)
    .join("\n");
  return [
    "根据以下任务记录与变更文件列表，写一条 git 提交消息。",
    "要求：",
    "- 一行中文，不超过 50 字，概括本次改动做了什么",
    "- 不加引号、不加「提交：」之类前缀、以动词开头",
    "- 只输出提交消息本身，不要任何解释",
    "",
    "任务记录（从早到晚）：",
    recent === "" ? "（无任务内容）" : recent,
    "",
    "变更文件：",
    files === "" ? "（无）" : files,
  ].join("\n");
}

/**
 * 由模型生成 commit 消息（一次不发工具的请求）。
 * 模型返回空白时抛中文错误，调用方可回退为手写。
 * 返回值附带本次调用的真实 usage（任务用量入账用，ADR 0029）；
 * 可选 onUsage 在请求结算后立即回调——消息无效抛错时 usage 已花仍照报
 * （尽力而为：报多少记多少）。
 */
export async function generateCommitMessage(options: {
  model: LanguageModel;
  messages: Pick<StoredMessage, "role" | "content">[];
  changedFiles: string[];
  /** 任务用量入账回调（ADR 0029）：成功与空白失败都回调，请求抛错不回调 */
  onUsage?: (usage: LanguageModelUsage) => void;
}): Promise<{ message: string; usage: LanguageModelUsage }> {
  const { text, usage } = await generateText({
    model: options.model,
    prompt: buildCommitMessagePrompt(options.messages, options.changedFiles),
  });
  options.onUsage?.(usage);
  const message = text.trim();
  if (message === "") {
    throw new Error("模型未返回有效的提交消息，请手动填写");
  }
  return { message, usage };
}
