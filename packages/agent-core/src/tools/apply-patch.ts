import {
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, relative } from "node:path";

import { expectString, parseToolArgs } from "./args";
import { defineTool } from "./define-tool";
import { splitLines } from "./read-file";
import { toDisplayPath } from "./paths";
import { resolvePath } from "./workspace";

/**
 * apply_patch：补丁式编辑（spec「工具注册表与内置工具」）。
 * 格式（类 Codex）：
 * ```
 * *** Begin Patch
 * *** Update File: <path>
 * @@              <- 可选的补丁块分隔行
 *  上下文行        <- 行首空格
 * -删除行
 * +新增行
 * *** Add File: <path>
 * +整个文件的每一行
 * *** Delete File: <path>
 * *** End Patch
 * ```
 * 上下文行与删除行必须与文件当前内容**精确匹配**（含空格）；
 * 失配即拒（错误含期望内容、文件中相近行与重试提示，模型可据此重试）；
 * 一个补丁多个文件时全部试算成功才写盘（原子）。
 */

type PatchLineType = "context" | "remove" | "add";
interface PatchLine {
  type: PatchLineType;
  text: string;
}
interface Hunk {
  lines: PatchLine[];
}
type FilePatch =
  | { kind: "update"; path: string; hunks: Hunk[] }
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";

class PatchFormatError extends Error {}

export function createApplyPatchTool() {
  return defineTool({
    name: "apply_patch",
    description:
      "用补丁编辑工作区内文件。补丁由 `*** Begin Patch` / `*** End Patch` 包裹，" +
      "每个文件一段（*** Update File / *** Add File / *** Delete File）。" +
      "Update 段中行首空格为上下文行、`-` 为删除行、`+` 为新增行，`@@` 可选作块分隔；" +
      "上下文与删除行必须与文件当前内容精确匹配（含空格），失配会被拒绝并返回原因——" +
      "此时先 read_file 确认内容再重试。局部修改优先用它而不是整文件重写。",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string", description: "完整的补丁文本" },
      },
      required: ["patch"],
      additionalProperties: false,
    },
    permission: "write",

    async execute(rawArgs, context) {
      const args = parseToolArgs(rawArgs);
      const patchText = expectString(args, "patch");
      const patches = parsePatch(patchText);
      if (patches.length === 0) {
        throw new PatchFormatError("补丁不包含任何文件操作段");
      }

      // 先对全部文件试算（内存变换），全部成功才写盘：拒绝是原子的
      const applied: { summary: string; write: () => void }[] = [];
      for (const patch of patches) {
        const absolute = resolvePath(
          context.workspacePath,
          patch.path,
          context.approvalMode
        );
        const display =
          toDisplayPath(relative(context.workspacePath, absolute)) ||
          toDisplayPath(patch.path);

        if (patch.kind === "add") {
          if (existsSync(absolute)) {
            throw new Error(
              `新建文件失败：${display} 已存在（如要修改请用 Update File）`
            );
          }
          const content =
            patch.lines.length > 0 ? `${patch.lines.join("\n")}\n` : "";
          applied.push({
            summary: `已新建 ${display}（${patch.lines.length} 行）`,
            write: () => {
              mkdirSync(dirname(absolute), { recursive: true });
              writeFileSync(absolute, content, "utf8");
            },
          });
          continue;
        }

        if (patch.kind === "delete") {
          if (!existsSync(absolute)) {
            throw new Error(`删除失败：${display} 不存在`);
          }
          applied.push({
            summary: `已删除 ${display}`,
            write: () => {
              unlinkSync(absolute);
            },
          });
          continue;
        }

        // Update：文件必须存在
        if (!existsSync(absolute)) {
          throw new Error(
            `更新失败：${display} 不存在（新建文件请用 *** Add File）`
          );
        }
        const original = readFileSync(absolute, "utf8");
        const { lines, hunkCount } = applyHunks(display, original, patch.hunks);
        const content =
          lines.length > 0
            ? `${lines.join("\n")}${original.endsWith("\n") || original === "" ? "\n" : ""}`
            : "";
        applied.push({
          summary: `已更新 ${display}（${hunkCount} 个补丁块）`,
          write: () => {
            writeFileSync(absolute, content, "utf8");
          },
        });
      }

      for (const item of applied) {
        item.write();
      }
      const summary = applied.map((item) => `- ${item.summary}`).join("\n");
      return {
        output: `补丁已应用（${applied.length} 个文件）：\n${summary}`,
        isError: false,
      };
    },
  });
}

// ---------- 解析 ----------

function parsePatch(text: string): FilePatch[] {
  const lines = splitLines(text);
  if (lines[0] !== BEGIN) {
    throw new PatchFormatError(`补丁必须以 ${BEGIN} 开头`);
  }
  const last = lines[lines.length - 1];
  if (last !== END) {
    throw new PatchFormatError(`补丁必须以 ${END} 结尾`);
  }

  const patches: FilePatch[] = [];
  let current: FilePatch | undefined;
  let hunk: Hunk | undefined;

  function startHunk() {
    if (current !== undefined && current.kind === "update") {
      hunk = { lines: [] };
      current.hunks.push(hunk);
    }
  }

  for (let index = 1; index < lines.length - 1; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("*** Update File: ")) {
      current = {
        kind: "update",
        path: line.slice("*** Update File: ".length).trim(),
        hunks: [],
      };
      patches.push(current);
      hunk = undefined;
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      current = {
        kind: "add",
        path: line.slice("*** Add File: ".length).trim(),
        lines: [],
      };
      patches.push(current);
      hunk = undefined;
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      current = {
        kind: "delete",
        path: line.slice("*** Delete File: ".length).trim(),
      };
      patches.push(current);
      hunk = undefined;
      continue;
    }
    if (current === undefined) {
      throw new PatchFormatError(
        `第 ${index + 1} 行「${line}」出现在任何文件段之前`
      );
    }
    if (current.kind === "delete") {
      throw new PatchFormatError(
        `Delete File 段（${current.path}）不允许有内容行`
      );
    }
    if (line.startsWith("@@")) {
      if (current.kind === "add") {
        throw new PatchFormatError(
          `Add File 段（${current.path}）不允许出现 @@`
        );
      }
      startHunk();
      continue;
    }
    if (line === "" || line === " ") {
      // 空行视作空的上下文行（宽容模型省略行首空格）
      if (current.kind === "update") {
        if (hunk === undefined) startHunk();
        hunk?.lines.push({ type: "context", text: "" });
      } else {
        throw new PatchFormatError(
          `Add File 段（${current.path}）的每一行须以 + 开头`
        );
      }
      continue;
    }
    const marker = line[0];
    const rest = line.slice(1);
    if (current.kind === "add") {
      if (marker !== "+") {
        throw new PatchFormatError(
          `Add File 段（${current.path}）的每一行须以 + 开头，实际是「${line}」`
        );
      }
      current.lines.push(rest);
      continue;
    }
    // update 段
    if (marker === " ") {
      if (hunk === undefined) startHunk();
      hunk?.lines.push({ type: "context", text: rest });
    } else if (marker === "-") {
      if (hunk === undefined) startHunk();
      hunk?.lines.push({ type: "remove", text: rest });
    } else if (marker === "+") {
      if (hunk === undefined) startHunk();
      hunk?.lines.push({ type: "add", text: rest });
    } else {
      throw new PatchFormatError(
        `第 ${index + 1} 行「${line}」不是合法的补丁行（行首须为空格、- 或 +）`
      );
    }
  }

  for (const patch of patches) {
    if (patch.path === "") {
      throw new PatchFormatError("文件段缺少路径（*** Update File: <路径>）");
    }
    if (
      patch.kind === "update" &&
      patch.hunks.every((h) => h.lines.length === 0)
    ) {
      throw new PatchFormatError(
        `Update File 段（${patch.path}）没有任何补丁行`
      );
    }
  }
  return patches;
}

// ---------- 应用 ----------

/** 在文件行中定位补丁块的旧内容序列（从 from 开始的朴素搜索） */
function indexOfSeq(
  haystack: string[],
  needle: string[],
  from: number
): number {
  if (needle.length === 0 || haystack.length < needle.length) {
    return -1;
  }
  outer: for (
    let start = from;
    start <= haystack.length - needle.length;
    start += 1
  ) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return start;
  }
  return -1;
}

function applyHunks(
  display: string,
  original: string,
  hunks: Hunk[]
): { lines: string[]; hunkCount: number } {
  const lines = splitLines(original);
  let cursor = 0;
  let appliedCount = 0;

  for (const hunk of hunks) {
    if (hunk.lines.length === 0) {
      continue;
    }
    const oldSeq = hunk.lines
      .filter((line) => line.type !== "add")
      .map((line) => line.text);
    const newSeq = hunk.lines
      .filter((line) => line.type !== "remove")
      .map((line) => line.text);
    if (oldSeq.length === 0) {
      throw new Error(
        `${display} 的第 ${appliedCount + 1} 个补丁块只有新增行，缺少上下文行或删除行，无法定位插入位置`
      );
    }
    const at = indexOfSeq(lines, oldSeq, cursor);
    if (at < 0) {
      throw new Error(
        describeMismatch(display, lines, oldSeq, appliedCount + 1)
      );
    }
    lines.splice(at, oldSeq.length, ...newSeq);
    cursor = at + newSeq.length;
    appliedCount += 1;
  }
  return { lines, hunkCount: appliedCount };
}

/** 失配原因：期望内容 + 文件中相近行 + 重试指引（模型可据此自我纠正） */
function describeMismatch(
  display: string,
  fileLines: string[],
  expected: string[],
  hunkNumber: number
): string {
  const head = expected
    .slice(0, 3)
    .map((line) => `  | ${line}`)
    .join("\n");
  // 对期望序列的每个非空行取探测片段，在文件中找相近行（帮助模型定位差异）。
  // 片段取两级长度：完整前缀失配时短前缀仍能定位「开头相同、行尾不同」的行。
  const probes: string[] = [];
  for (const line of expected.filter((l) => l.trim() !== "").slice(0, 5)) {
    const trimmed = line.trim();
    probes.push(trimmed.slice(0, 20));
    if (trimmed.length > 10) {
      probes.push(trimmed.slice(0, 10));
    }
  }
  const hits: string[] = [];
  for (let index = 0; index < fileLines.length && hits.length < 3; index += 1) {
    const line = fileLines[index]!;
    if (probes.some((probe) => line.includes(probe))) {
      hits.push(`第 ${index + 1} 行 \`${line}\``);
    }
  }
  const nearby =
    hits.length > 0 ? `文件中与之相近的行：${hits.join("、")}。\n` : "";
  return (
    `补丁未应用：${display} 的第 ${hunkNumber} 个补丁块在文件中找不到匹配的上下文` +
    "（上下文与删除行须与文件当前内容精确匹配，包括空白）。\n" +
    `期望的现有内容开头：\n${head}\n` +
    nearby +
    "请先用 read_file 查看该文件当前内容，再基于实际内容重新生成补丁。"
  );
}
