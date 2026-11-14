/**
 * 任务截图的文件路径约定（工单 11；session→task 改名随票 03 换目录）：
 * 截图工具与「读回图片」的 IPC handler 共用。「重启后可找回」的前提是
 * desktop 恒注入 dataDir 下的持久目录（main.ts 的 screenshotDirFor）；
 * 若截图目录落在临时目录（agent-core 默认值），重启后不保证找回。约定式
 * 路径本身只保证按 任务id+调用id 定位文件，无需登记表。
 */
import { join } from "node:path";

/** 任务截图目录：<数据目录>/tasks/<任务id>/screenshots */
export function taskScreenshotDir(dataDir: string, taskId: string): string {
  return join(dataDir, "tasks", taskId, "screenshots");
}

/** 单张截图文件路径：<截图目录>/<toolCallId>.png */
export function screenshotPathFor(
  dataDir: string,
  taskId: string,
  toolCallId: string
): string {
  // toolCallId 由模型端点生成（字母数字与连字符）；防御非法路径字符
  const safeId = toolCallId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(taskScreenshotDir(dataDir, taskId), `${safeId}.png`);
}
