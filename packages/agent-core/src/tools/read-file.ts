import { statSync } from "node:fs";
import { open } from "node:fs/promises";

import { expectString, optionalNumber, parseToolArgs } from "./args";
import { defineTool } from "./define-tool";
import { toDisplayPath } from "./paths";
import { resolvePath } from "./workspace";

export interface ReadFileToolOptions {
  /** 单次读取的行数上限（默认 2000；模型未显式指定 limit 时超出即截断并标记） */
  maxLines?: number;
}

/** read_file：读取工作区内文本文件，输出「行号\\t内容」，超长截断有标记（spec「工具执行与截断」） */
export function createReadFileTool(options: ReadFileToolOptions = {}) {
  const maxLines = options.maxLines ?? 2000;

  const tool = defineTool({
    name: "read_file",
    description:
      "读取工作区内的文本文件，输出带行号的内容（格式「行号\\t该行内容」）。" +
      `单次最多 ${maxLines} 行，可用 offset（1 起始行号）与 limit 分段读取。` +
      "编辑文件前先用它确认上下文。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "工作区内相对路径（或工作区内绝对路径）",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "起始行号（1 起始，默认 1）",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "本次读取的行数上限",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    permission: "readonly",

    async execute(rawArgs, context) {
      const args = parseToolArgs(rawArgs);
      const target = expectString(args, "path");
      const requestedOffset = Math.max(optionalNumber(args, "offset") ?? 1, 1);
      const requestedLimit = optionalNumber(args, "limit");
      if (requestedLimit === 0) throw new Error("参数 limit 必须为正整数");
      // 上限保护：即使模型要求更多，单次也不超过 maxLines
      const limit = Math.min(requestedLimit ?? maxLines, maxLines);

      const absolute = resolvePath(
        context.workspacePath,
        target,
        context.approvalMode
      );
      let stats;
      try {
        stats = statSync(absolute);
      } catch {
        throw new Error(`文件不存在：${toDisplayPath(target)}`);
      }
      if (stats.isDirectory()) {
        throw new Error(
          `${toDisplayPath(target)} 是目录，read_file 只能读文件`
        );
      }
      return await readRange(
        absolute,
        toDisplayPath(target),
        requestedOffset,
        limit,
        requestedLimit === undefined || requestedLimit > maxLines,
        context.signal ?? undefined
      );
    },
  });
  return {
    ...tool,
    async execute(...args: Parameters<typeof tool.execute>) {
      const result = await tool.execute(...args);
      // defineTool 生成的错误（含模型输入的路径）也计入最终预算。
      return { ...result, output: boundedOutput(result.output) };
    },
  };
}

const OUTPUT_BYTES = 128 * 1024;
const SCAN_BYTES = 8 * 1024 * 1024;
const BLOCK_BYTES = 64 * 1024;
const OUTPUT_MARKER = "\n[已截断：输出超过 128 KiB，请缩小读取范围]\n";

/** 连同标记限制最终字节数；不把有效 UTF-8 字符截成替换字符。 */
function boundedOutput(output: string, marker = ""): string {
  const bytes = Buffer.from(output);
  if (bytes.length + Buffer.byteLength(marker) <= OUTPUT_BYTES)
    return output + marker;
  const suffix = marker || OUTPUT_MARKER;
  let end = OUTPUT_BYTES - Buffer.byteLength(suffix);
  while ((bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8") + suffix;
}

async function readRange(
  path: string,
  display: string,
  offset: number,
  limit: number,
  reportLineLimit: boolean,
  signal?: AbortSignal
) {
  const checkAbort = () => {
    if (signal?.aborted) throw new Error("读取已被用户中断");
  };
  checkAbort();
  const handle = await open(path, "r");
  try {
    checkAbort();
    const stats = await handle.stat();
    const buffer = Buffer.alloc(BLOCK_BYTES);
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    let scanned = 0;
    let line = 1;
    let lineText = "";
    let output = "";
    let outputBytes = 0;
    const endLine = offset + limit;

    const finishLine = () => {
      if (line >= offset) {
        const content = lineText.endsWith("\r")
          ? lineText.slice(0, -1)
          : lineText;
        const numbered = `${line}\t${content}\n`;
        output += numbered;
        outputBytes += Buffer.byteLength(numbered);
      }
      lineText = "";
      line += 1;
    };

    while (scanned < stats.size && scanned < SCAN_BYTES) {
      checkAbort();
      const length = Math.min(
        BLOCK_BYTES,
        SCAN_BYTES - scanned,
        stats.size - scanned
      );
      const { bytesRead } = await handle.read(buffer, 0, length, scanned);
      checkAbort();
      if (bytesRead === 0) break;
      const block = buffer.subarray(0, bytesRead);
      if (block.includes(0))
        throw new Error(`${display} 是二进制文件，read_file 只支持文本`);
      scanned += bytesRead;
      const text = decoder.decode(block, { stream: scanned < stats.size });
      let start = 0;
      while (start < text.length) {
        const newline = text.indexOf("\n", start);
        const end = newline === -1 ? text.length : newline;
        if (line >= offset) {
          lineText += text.slice(start, end);
          if (
            outputBytes + Buffer.byteLength(`${line}\t${lineText}\n`) >
            OUTPUT_BYTES
          ) {
            return {
              output: boundedOutput(output + `${line}\t${lineText}\n`),
              isError: false,
            };
          }
        }
        if (newline === -1) break;
        finishLine();
        start = newline + 1;
        if (line >= endLine) {
          const more = start < text.length || scanned < stats.size;
          const marker =
            reportLineLimit && more
              ? `[已截断：达到行数上限，当前显示第 ${offset}-${line - 1} 行；可用 offset 继续读取]\n`
              : "";
          return { output: boundedOutput(output, marker), isError: false };
        }
      }
    }
    if (scanned < stats.size && scanned >= SCAN_BYTES) {
      const marker =
        "\n[已截断：扫描达到 8 MiB 上限，未完成请求范围，请使用搜索工具定位内容]\n";
      return { output: boundedOutput(output, marker), isError: true };
    }
    if (scanned === 0)
      return { output: boundedOutput(`${display} 为空文件`), isError: false };
    if (lineText !== "") finishLine();
    return { output: boundedOutput(output), isError: false };
  } finally {
    await handle.close();
  }
}

/** 按换行拆行；结尾换行不产生末尾空行（CRLF 容忍） */
export function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}
