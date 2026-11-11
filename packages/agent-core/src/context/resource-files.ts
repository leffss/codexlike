import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type { ResourceDiagnostic } from "./resource-types";

/** 只保存文件身份/版本，不在发现阶段保存正文。 */
export interface CapturedResourceFile {
  path: string;
  realPath: string;
  boundary: string;
  version: string;
  bytes: number;
}

export function isWithin(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

function fingerprint(stats: Stats): string {
  return [
    stats.dev,
    stats.ino,
    stats.size,
    stats.mtimeMs,
    stats.ctimeMs,
    stats.mode,
  ].join(":");
}

export function captureResourceFile(
  path: string,
  boundary: string
): CapturedResourceFile {
  const realPath = realpathSync(path);
  const realBoundary = realpathSync(boundary);
  if (!isWithin(realBoundary, realPath))
    throw new Error(`符号链接越界：${path}`);
  const stats = statSync(realPath);
  if (!stats.isFile()) throw new Error(`资源不是普通文件：${path}`);
  return {
    path: resolve(path),
    realPath,
    boundary: realBoundary,
    version: fingerprint(stats),
    bytes: stats.size,
  };
}

function assertUnchanged(file: CapturedResourceFile) {
  try {
    if (
      realpathSync(file.path) !== file.realPath ||
      !isWithin(file.boundary, file.realPath)
    )
      throw new Error();
    const stats = statSync(file.realPath);
    if (!stats.isFile() || fingerprint(stats) !== file.version)
      throw new Error();
  } catch {
    throw new Error(`资源在快照后发生变化，请在下一条消息刷新：${file.path}`);
  }
}

/** 所有读取共用安全打开和前后版本校验。 */
function withCapturedFile(
  file: CapturedResourceFile,
  read: (fd: number) => Buffer
): Buffer {
  assertUnchanged(file);
  const fd = openSync(
    file.realPath,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || fingerprint(stats) !== file.version)
      throw new Error(`资源在打开时发生变化：${file.path}`);
    const result = read(fd);
    if (fingerprint(fstatSync(fd)) !== file.version)
      throw new Error(`资源在读取时发生变化：${file.path}`);
    assertUnchanged(file);
    return result;
  } finally {
    closeSync(fd);
  }
}

/** 固定文件身份读取，最多读取指定字节。 */
export function readCapturedBytes(
  file: CapturedResourceFile,
  maxBytes: number
): Buffer {
  return withCapturedFile(file, (fd) => {
    const buffer = Buffer.alloc(Math.min(file.bytes, maxBytes));
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(fd, buffer, total, buffer.length - total, total);
      if (!count) break;
      total += count;
    }
    return buffer.subarray(0, total);
  });
}

/** 逐字节读到 frontmatter 结束行，绝不越过分隔行预读正文。
 * 复用一个有界 buffer，仅在换行时解析本行，避免逐字节解码或重复扫描。
 */
export function readCapturedFrontmatter(
  file: CapturedResourceFile,
  maxBytes: number
): Buffer {
  return withCapturedFile(file, (fd) => {
    const buffer = Buffer.alloc(Math.min(file.bytes, maxBytes));
    let total = 0;
    let lineStart = 0;
    while (total < buffer.length) {
      if (!readSync(fd, buffer, total, 1, total)) break;
      total++;
      if (buffer[total - 1] !== 10) continue;
      const line = buffer
        .toString("utf8", lineStart, total)
        .replace(/\r?\n$/, "");
      const opening = lineStart === 0;
      lineStart = total;
      if (opening ? !/^\uFEFF?---$/.test(line) : line === "---") break;
    }
    return buffer.subarray(0, total);
  });
}

/** 目录快照只 stat，不读取附属文件正文；循环链接与过深目录不会无限遍历。 */
export function captureResourceTree(
  directory: string,
  diagnostics: ResourceDiagnostic[]
): Map<string, CapturedResourceFile> {
  const files = new Map<string, CapturedResourceFile>();
  const boundary = realpathSync(directory);
  let visited = 0;
  function walk(path: string, ancestors: Set<string>, depth: number) {
    try {
      if (++visited > 10000 || depth > 32)
        throw new Error("附属资源目录超过扫描上限（10000 项 / 32 层）");
      const real = realpathSync(path);
      if (!isWithin(boundary, real)) throw new Error("附属资源符号链接越界");
      const stats = statSync(real);
      if (stats.isDirectory()) {
        if (ancestors.has(real)) throw new Error("附属资源目录符号链接循环");
        const next = new Set(ancestors).add(real);
        for (const name of readdirSync(path).sort()) {
          if (visited >= 10000) {
            diagnostics.push({
              path,
              message: "附属资源目录超过 10000 项扫描上限",
            });
            break;
          }
          walk(join(path, name), next, depth + 1);
        }
      } else {
        files.set(resolve(path), captureResourceFile(path, directory));
      }
    } catch (error) {
      diagnostics.push({
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  walk(directory, new Set(), 0);
  return files;
}

export function resolveResourcePath(directory: string, path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    /[\u0000-\u001f:]/.test(path)
  ) {
    throw new Error("资源路径必须为技能目录内的相对路径");
  }
  const resolved = resolve(directory, ...path.split(/[\\/]/));
  if (!isWithin(directory, resolved) || resolved === directory)
    throw new Error("资源路径逃逸技能目录");
  return resolved;
}

export function readResourceText(
  file: CapturedResourceFile,
  maxBytes: number
): string {
  if (file.bytes > maxBytes)
    throw new Error(`资源超过 ${maxBytes / 1024} KiB 限制：${file.path}`);
  const buffer = readCapturedBytes(file, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`资源不是有效 UTF-8 文本：${file.path}`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
    throw new Error(`拒绝二进制资源：${file.path}`);
  return text;
}
