import { generateText, type LanguageModel } from 'ai';

import type { StoredMessage } from '../session/types';

/**
 * 一键 commit 的消息生成（spec「git 集成」）：commit 消息默认由模型按会话内容生成，
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
  messages: Pick<StoredMessage, 'role' | 'content'>[],
  changedFiles: string[],
): string {
  // error 是给用户看的中文提示，不属于会话内容；只取最近 20 条、每条截 400 字符
  const recent = messages
    .filter((message) => message.role !== 'error')
    .slice(-MAX_MESSAGES)
    .map(
      (message) =>
        `${message.role === 'user' ? '用户' : '助手'}：${message.content.slice(0, MAX_MESSAGE_CHARS)}`,
    )
    .join('\n');
  const files = changedFiles
    .slice(0, MAX_FILES)
    .map((path) => `- ${path}`)
    .join('\n');
  return [
    '根据以下会话记录与变更文件列表，写一条 git 提交消息。',
    '要求：',
    '- 一行中文，不超过 50 字，概括本次改动做了什么',
    '- 不加引号、不加「提交：」之类前缀、以动词开头',
    '- 只输出提交消息本身，不要任何解释',
    '',
    '会话记录（从早到晚）：',
    recent === '' ? '（无会话内容）' : recent,
    '',
    '变更文件：',
    files === '' ? '（无）' : files,
  ].join('\n');
}

/**
 * 由模型生成 commit 消息（一次不发工具的请求）。
 * 模型返回空白时抛中文错误，调用方可回退为手写。
 */
export async function generateCommitMessage(options: {
  model: LanguageModel;
  messages: Pick<StoredMessage, 'role' | 'content'>[];
  changedFiles: string[];
}): Promise<string> {
  const { text } = await generateText({
    model: options.model,
    prompt: buildCommitMessagePrompt(options.messages, options.changedFiles),
  });
  const message = text.trim();
  if (message === '') {
    throw new Error('模型未返回有效的提交消息，请手动填写');
  }
  return message;
}
