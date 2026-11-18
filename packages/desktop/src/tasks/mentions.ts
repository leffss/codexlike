import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { MentionAttachment } from "@codexlike/agent-core";

/** @引用 单文件的内容上限：超出截断（spec：超长输出截断） */
export const MENTION_MAX_BYTES = 128 * 1024;

/**
 * 读取 @引用 的工作区文件（工单 07：@文件引用）。
 * 安全基线（spec「审批与安全」）：路径必须真实落在工作区内——
 * `..` 与符号链接逃逸一律拒绝（realpath 校验后做前缀比较）。
 * 出错抛带中文提示的 Error（IPC 边界转给渲染进程回显）。
 */
export function readMentionAttachments(
  workspacePath: string,
  paths: string[]
): MentionAttachment[] {
  const workspaceAbsolute = resolve(workspacePath);
  const workspaceReal = realpathSync(workspacePath);
  return paths.map((raw) => {
    if (isAbsolute(raw)) {
      throw new Error(`@引用 不允许使用绝对路径：${raw}`);
    }
    const absolute = resolve(workspacePath, raw);
    // 字符串级前缀校验（resolve 已消化 ..；不依赖目标存在）
    if (
      absolute !== workspaceAbsolute &&
      !absolute.startsWith(`${workspaceAbsolute}${sep}`)
    ) {
      throw new Error(`@引用 的路径在工作区外，不允许读取：${raw}`);
    }
    // realpath 再校验：符号链接不得逃逸出工作区
    const real = safeRealpath(raw, absolute);
    if (real !== workspaceReal && !real.startsWith(`${workspaceReal}${sep}`)) {
      throw new Error(`@引用 的路径指向工作区外，不允许读取：${raw}`);
    }
    if (!statSync(real).isFile()) {
      throw new Error(`@引用 的路径不是文件：${raw}`);
    }
    // 预算之外只多读一个字节判断是否截断，不随文件大小分配或同步全量读取。
    const fd = openSync(real, "r");
    const buffer = Buffer.alloc(MENTION_MAX_BYTES + 1);
    let total = 0;
    try {
      while (total < buffer.length) {
        const count = readSync(fd, buffer, total, buffer.length - total, total);
        if (count === 0) break;
        total += count;
      }
    } finally {
      closeSync(fd);
    }
    if (total > MENTION_MAX_BYTES) {
      // 流式解码暂存末尾半个字符（不调用 end），保留原文中的完整替换符。
      const head = new StringDecoder("utf8").write(
        buffer.subarray(0, MENTION_MAX_BYTES)
      );
      return {
        path: raw,
        content: `${head}\n\n（文件超过 128 KiB，内容已截断）`,
      };
    }
    return { path: raw, content: buffer.toString("utf8", 0, total) };
  });
}

/** realpath；目标不存在时抛中文错误（引用后文件被删的场景） */
function safeRealpath(raw: string, absolute: string): string {
  try {
    return realpathSync(absolute);
  } catch {
    throw new Error(`@引用 的文件不存在：${raw}`);
  }
}
