import { readFileSync, statSync } from "node:fs";

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

  return defineTool({
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
      const buffer = readFileSync(absolute);
      // 二进制内容对模型无意义且污染上下文：检测 NUL 直接拒绝
      if (buffer.includes(0)) {
        throw new Error(
          `${toDisplayPath(target)} 是二进制文件，read_file 只支持文本`
        );
      }

      const text = buffer.toString("utf8");
      const lines = splitLines(text);
      if (lines.length === 0) {
        return { output: `${toDisplayPath(target)} 为空文件`, isError: false };
      }

      const slice = lines.slice(
        requestedOffset - 1,
        requestedOffset - 1 + limit
      );
      let output = slice
        .map((line, index) => `${requestedOffset + index}\t${line}`)
        .join("\n");
      if (slice.length > 0) {
        output += "\n";
      }
      // 截断标记只在「模型未主动要求停在范围末尾」时出现：
      // 显式给了 offset/limit 的是分段读取，不是截断；limit 被上限压低才是。
      const truncatedByLimit =
        requestedLimit !== undefined && requestedLimit > maxLines;
      if (
        (requestedLimit === undefined || truncatedByLimit) &&
        requestedOffset - 1 + slice.length < lines.length
      ) {
        output += `[已截断：文件共 ${lines.length} 行，当前显示第 ${requestedOffset}-${requestedOffset - 1 + slice.length} 行]\n`;
      }
      return { output, isError: false };
    },
  });
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
