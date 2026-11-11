import {
  fuzzyMatch,
  parseComposerDraft,
  SLASH_COMMANDS,
  type SlashCommandDef,
  type SkillDescriptor,
} from "@codexlike/agent-core";

/**
 * 输入框菜单（/ 命令与 @文件引用）的纯函数核心：
 * - computeMenu：由草稿解析结果计算菜单条目与初始高亮；
 * - handleMenuKey：键盘导航（↑↓ 移动、Enter/Tab 选中、Esc 关闭）；
 * - applyMentionSelection：把选中的文件写回输入框文本。
 * 组件层只做渲染与光标操作。
 */

/** @引用 菜单最多展示的候选条数 */
const MENTION_MENU_LIMIT = 20;

export interface ComposerMenuState {
  kind: "slash-commands" | "mentions" | "skills";
  /** 命令、文件相对路径或有效技能元数据。 */
  items: readonly (SlashCommandDef | string | SkillDescriptor)[];
  activeIndex: number;
  /** mentions 菜单：@ 字符在输入框文本中的位置（选中写回用） */
  mentionStart?: number;
  skillStart?: number;
}

export function computeMenu(
  draft: ReturnType<typeof parseComposerDraft>,
  options: {
    commands?: readonly SlashCommandDef[];
    files: readonly string[];
    skills?: readonly SkillDescriptor[];
  }
): ComposerMenuState | null {
  const commands = options.commands ?? SLASH_COMMANDS;
  if (draft.menu === "slash-commands") {
    const items = fuzzyMatch(draft.query, commands, (command) => command.name);
    return items.length === 0
      ? null
      : { kind: "slash-commands", items, activeIndex: 0 };
  }
  if (draft.menu === "skills") {
    const items = fuzzyMatch(
      draft.query,
      (options.skills ?? []).filter((skill) => skill.status === "active"),
      (skill) => `${skill.name} ${skill.description}`
    ).slice(0, MENTION_MENU_LIMIT);
    return items.length === 0
      ? null
      : { kind: "skills", items, activeIndex: 0, skillStart: draft.skillStart };
  }
  if (draft.menu === "mentions") {
    const items = fuzzyMatch(draft.query, [...options.files]).slice(
      0,
      MENTION_MENU_LIMIT
    );
    return items.length === 0
      ? null
      : {
          kind: "mentions",
          items,
          activeIndex: 0,
          mentionStart: draft.mentionStart,
        };
  }
  return null;
}

export type MenuKeyResult =
  | { action: "move"; activeIndex: number }
  | { action: "select"; item: SlashCommandDef | string | SkillDescriptor }
  | { action: "close" }
  | { action: "default" };

export function handleMenuKey(
  menu: ComposerMenuState,
  key: string
): MenuKeyResult {
  const lastIndex = menu.items.length - 1;
  if (key === "ArrowDown") {
    return {
      action: "move",
      activeIndex: (menu.activeIndex + 1) % menu.items.length,
    };
  }
  if (key === "ArrowUp") {
    return {
      action: "move",
      activeIndex: menu.activeIndex === 0 ? lastIndex : menu.activeIndex - 1,
    };
  }
  if (key === "Enter" || key === "Tab") {
    return { action: "select", item: menu.items[menu.activeIndex]! };
  }
  if (key === "Escape") {
    return { action: "close" };
  }
  return { action: "default" };
}

/** 选择技能只替换引用，不发送消息；保留后续标点和其他引用。 */
export function applySkillSelection(input: {
  text: string;
  skillStart: number;
  selectedName: string;
  caretIndex?: number;
}): { text: string; caretIndex: number } {
  let end = input.caretIndex ?? input.text.length;
  while (end < input.text.length && /[a-z0-9-]/.test(input.text[end]!))
    end += 1;
  const rest = input.text.slice(end);
  const replacement = `$${input.selectedName}${/^\s/.test(rest) ? "" : " "}`;
  return {
    text: input.text.slice(0, input.skillStart) + replacement + rest,
    caretIndex:
      input.skillStart + replacement.length + (/^\s/.test(rest) ? 1 : 0),
  };
}

/**
 * 把选中的文件路径写回输入框：替换从 @ 到 token 尾部的整段文本，
 * 路径后补一个空格（避免与后续文字粘连），光标移到空格后。
 */
export function applyMentionSelection(input: {
  text: string;
  mentionStart: number;
  selectedPath: string;
  /** 光标位置（默认文本末尾）；token 尾部边界（默认扫描到空白/终止符，供光标在 token 中间时用） */
  caretIndex?: number;
  tokenEnd?: number;
}): { text: string; caretIndex: number } {
  const { text, mentionStart, selectedPath } = input;
  const caret = input.caretIndex ?? text.length;
  // token 尾部：显式给定；否则从光标向后扫到空白或文本末尾
  let tokenEnd = input.tokenEnd;
  if (tokenEnd === undefined) {
    tokenEnd = caret;
    while (tokenEnd < text.length && !/\s/.test(text[tokenEnd]!)) {
      tokenEnd += 1;
    }
  }
  // 替换段后若已是空白（或文本结束）则不再补空格，避免双空格
  const rest = text.slice(tokenEnd);
  const replacement = /^\s/.test(rest)
    ? `@${selectedPath}`
    : `@${selectedPath} `;
  const next = text.slice(0, mentionStart) + replacement + rest;
  return {
    text: next,
    caretIndex: mentionStart + replacement.length,
  };
}
