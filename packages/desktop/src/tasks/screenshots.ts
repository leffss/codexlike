/**
 * 会话截图的文件路径约定（工单 11）：截图工具与「读回图片」的 IPC handler 共用。
 * 约定式路径让重启后的历史截图卡片也能按 会话id+调用id 找回文件，无需登记表。
 */
import { join } from "node:path";

/** 会话截图目录：<数据目录>/sessions/<会话id>/screenshots */
export function taskScreenshotDir(dataDir: string, sessionId: string): string {
  return join(dataDir, "sessions", sessionId, "screenshots");
}

/** 单张截图文件路径：<截图目录>/<toolCallId>.png */
export function screenshotPathFor(
  dataDir: string,
  sessionId: string,
  toolCallId: string
): string {
  // toolCallId 由模型端点生成（字母数字与连字符）；防御非法路径字符
  const safeId = toolCallId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(taskScreenshotDir(dataDir, sessionId), `${safeId}.png`);
}
