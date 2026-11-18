import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * 四个 JSON 设置存储（profiles / mcp / subagents / search）共享的文件读写。
 * 读：ENOENT → fallback（未配置态）；写：同目录临时文件完整写入后原子替换。
 * 损坏（非法 JSON）默认抛错，由调用方决定是否容错（corruptAsFallback）。
 */
export function readJsonFile<T>(
  filePath: string,
  fallback: T,
  options: { corruptAsFallback?: boolean } = {}
): T {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    if (options.corruptAsFallback === true) {
      return fallback;
    }
    throw error;
  }
}

export function writeJsonFile(filePath: string, value: unknown): void {
  const content = JSON.stringify(value, null, 2);
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `.${basename(filePath)}.${randomUUID()}.tmp`);
  // 排他创建，只有成功取得的临时文件归本次写入所有，失败清理不碰其他文件。
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, content, "utf8");
    } finally {
      closeSync(fd);
    }
    // Node 在 Windows 同样支持替换已有文件；不得先删旧文件作为 fallback。
    renameSync(temporary, filePath);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // 清理失败不能遮蔽原始写入错误，旧目标仍保持不变。
    }
    throw error;
  }
}
