import { SLASH_COMMANDS, type SlashCommandName } from './slash-command';

export { SLASH_COMMANDS };
export type {
  SlashCommandDef,
  SlashCommandName,
} from './slash-command';

/**
 * 输入框解析层（纯函数，浏览器安全）：ui 直接值导入用于命令菜单与发送分发。
 * 两个入口：
 * - `resolveComposerSubmission`：发送时——整条输入是命令还是消息、消息里引用了哪些文件；
 * - `parseComposerDraft`：输入中——光标处是否正在键入命令 / @引用（驱动弹出菜单）。
 */

/** 发送时解析结果 */
export type ComposerSubmission =
  | {
      kind: 'slash-command';
      name: SlashCommandName;
      /** 命令参数（如 /rename 新名称 的「新名称」）；无参数为空串 */
      argument: string;
      /** trim 后的原始输入（消息流回显 / 菜单回填用） */
      raw: string;
    }
  | {
      kind: 'message';
      /** trim 后的消息原文（@token 保留在文本中） */
      text: string;
      /** @引用 的工作区相对路径，按出现顺序去重 */
      mentionPaths: string[];
    };

/**
 * @引用 token 的终止字符：空白之外的常见中英文标点。
 * 自然语言里 `@docs/说明.md，再读` 的逗号不属于路径。
 */
const MENTION_TERMINATORS = new Set(
  '，。；：、！？（）【】《》「」『』“”‘’…—§,;:!?()[]{}<>"\'`|\\\n\t\r ',
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
    if (text[i] !== '@' || !isMentionStart(text, i)) {
      continue;
    }
    let end = i + 1;
    while (end < text.length && !MENTION_TERMINATORS.has(text[end]!)) {
      end += 1;
    }
    const path = text.slice(i + 1, end);
    if (path !== '' && !paths.includes(path)) {
      paths.push(path);
    }
  }
  return paths;
}

/** 发送时解析：空/纯空白返回 null；行首已知命令 → 斜杠命令；其余为普通消息 */
export function resolveComposerSubmission(
  input: string,
): ComposerSubmission | null {
  const raw = input.trim();
  if (raw === '') {
    return null;
  }
  if (raw.startsWith('/')) {
    // 命令名 = 第一个空白前的 token；参数 = 其余全部（trim）
    const separator = /\s/.exec(raw);
    const head = separator === null ? raw : raw.slice(0, separator.index);
    const argument =
      separator === null ? '' : raw.slice(separator.index + 1).trim();
    const name = head.slice(1).toLowerCase();
    const known = SLASH_COMMANDS.find(
      (command) => command.name === name,
    );
    if (known !== undefined) {
      return { kind: 'slash-command', name: known.name, argument, raw };
    }
  }
  return { kind: 'message', text: raw, mentionPaths: extractMentionPaths(raw) };
}
