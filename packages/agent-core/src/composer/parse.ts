import { SLASH_COMMANDS, type SlashCommandName } from "./slash-command";
import { skillReferenceAt } from "./skill-reference";

export { SLASH_COMMANDS };
export type { SlashCommandDef, SlashCommandName } from "./slash-command";

/**
 * 输入框解析层（纯函数，浏览器安全）：ui 直接值导入用于命令菜单与发送分发。
 * 两个入口：
 * - `resolveComposerSubmission`：发送时——整条输入是命令还是消息、消息里引用了哪些文件；
 * - `parseComposerDraft`：输入中——光标处是否正在键入命令 / @引用（驱动弹出菜单）。
 */

/** 发送时解析结果 */
export type ComposerSubmission =
  | {
      kind: "slash-command";
      name: SlashCommandName;
      /** 命令参数（如 /rename 新名称 的「新名称」）；无参数为空串 */
      argument: string;
      /** trim 后的原始输入（消息流回显 / 菜单回填用） */
      raw: string;
    }
  | {
      kind: "message";
      /** 消息原文（通常 trim；首个非空行的 Markdown 代码缩进保留） */
      text: string;
      /** @引用 的工作区相对路径，按出现顺序去重 */
      mentionPaths: string[];
    };

/**
 * @引用 token 的终止字符：空白之外的常见中英文标点。
 * 自然语言里 `@docs/说明.md，再读` 的逗号不属于路径。
 */
const MENTION_TERMINATORS = new Set(
  "，。；：、！？（）【】《》「」『』“”‘’…—§,;:!?()[]{}<>\"'`|\\\n\t\r "
);

/** @ 前必须是行首或空白（user@example.com 一类不构成引用） */
function isMentionStart(text: string, atIndex: number): boolean {
  if (atIndex === 0) {
    return true;
  }
  return /\s/.test(text[atIndex - 1]!);
}

/** 提取文本中全部 @引用 路径（相对工作区），按出现顺序去重 */
export function extractMentionPaths(text: string): string[] {
  const paths: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "@" || !isMentionStart(text, i)) {
      continue;
    }
    let end = i + 1;
    while (end < text.length && !MENTION_TERMINATORS.has(text[end]!)) {
      end += 1;
    }
    const path = text.slice(i + 1, end);
    if (path !== "" && !paths.includes(path)) {
      paths.push(path);
    }
  }
  return paths;
}

/** 发送时解析：空/纯空白返回 null；行首已知命令 → 斜杠命令；其余为普通消息 */
export function resolveComposerSubmission(
  input: string
): ComposerSubmission | null {
  const raw = input.trim();
  if (raw === "") {
    return null;
  }
  if (raw.startsWith("/")) {
    // 命令名 = 第一个空白前的 token；参数 = 其余全部（trim）
    const separator = /\s/.exec(raw);
    const head = separator === null ? raw : raw.slice(0, separator.index);
    const argument =
      separator === null ? "" : raw.slice(separator.index + 1).trim();
    const name = head.slice(1).toLowerCase();
    const known = SLASH_COMMANDS.find((command) => command.name === name);
    if (known !== undefined) {
      return { kind: "slash-command", name: known.name, argument, raw };
    }
  }
  // 只保留有 Markdown 意义的首行缩进；普通消息仍沿用 trim 行为。
  const firstContentLine =
    input.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  const text = /^(?: {4}| {0,3}\t)/.test(firstContentLine)
    ? input.trimEnd()
    : raw;
  return { kind: "message", text, mentionPaths: extractMentionPaths(text) };
}

/** 输入中（光标）解析结果：驱动 `/` 命令菜单与 `@引用` 文件菜单的弹出 */
export type ComposerDraftMenu =
  | { menu: "slash-commands"; query: string }
  /** mentionStart = @ 字符在原文中的位置（菜单选中后据此替换 token） */
  | { menu: "mentions"; query: string; mentionStart: number }
  | { menu: "skills"; query: string; skillStart: number }
  | { menu: null };

/**
 * 光标处的草稿解析（输入中）：
 * - 首个非空白字符是 `/` 且无换行 → 命令菜单（query 为命令 token）；
 *   已知命令已完整并跟空白（正在输参数）时不再弹出；
 * - 光标位于 @token 内（@ 与光标间无空白/终止标点，@ 前是行首或空白）
 *   → 引用菜单（query 为 @ 到光标的文本）。
 */
export function parseComposerDraft(
  text: string,
  options?: { caretIndex?: number }
): ComposerDraftMenu {
  const caret = options?.caretIndex ?? text.length;

  // 命令草稿：单行、行首 /
  if (!text.includes("\n")) {
    const slashIndex = text.indexOf("/");
    const head = text.slice(0, slashIndex);
    if (slashIndex !== -1 && head.trim() === "") {
      let tokenEnd = slashIndex + 1;
      while (tokenEnd < text.length && !/\s/.test(text[tokenEnd]!)) {
        tokenEnd += 1;
      }
      const token = text.slice(slashIndex + 1, tokenEnd);
      const known = SLASH_COMMANDS.find(
        (command) => command.name === token.toLowerCase()
      );
      // 命令名仍在输入中（或未知 token 交给菜单层过滤），且光标在 token 内
      const typingToken = tokenEnd >= text.length || known === undefined;
      if (typingToken && caret >= slashIndex + 1 && caret <= tokenEnd) {
        return {
          menu: "slash-commands",
          query: token.slice(0, caret - (slashIndex + 1)),
        };
      }
      return { menu: null };
    }
  }

  const skill = skillReferenceAt(text, caret);
  if (skill !== null) {
    return { menu: "skills", ...skill };
  }

  // 引用草稿：光标向前扫描到最近的 @（不得隔着空白/终止标点）
  let scan = caret - 1;
  while (
    scan >= 0 &&
    text[scan] !== "@" &&
    !MENTION_TERMINATORS.has(text[scan]!)
  ) {
    scan -= 1;
  }
  if (scan >= 0 && text[scan] === "@" && isMentionStart(text, scan)) {
    return {
      menu: "mentions",
      query: text.slice(scan + 1, caret),
      mentionStart: scan,
    };
  }
  return { menu: null };
}
