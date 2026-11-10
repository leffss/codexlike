/**
 * 斜杠命令词汇表（GLOSSARY「斜杠命令」）。
 * 输入框以 `/` 开头的一行输入构成命令，与等效 UI 操作走同一 IPC 通道（工单 07）。
 */

/** 内置命令名（spec：/new /rename /archive /model /status；/compact 由工单 08 增加） */
export type SlashCommandName = 'new' | 'rename' | 'archive' | 'model' | 'status';

export interface SlashCommandDef {
  readonly name: SlashCommandName;
  /** 中文描述（命令菜单展示） */
  readonly description: string;
  /** 参数提示（占位文案）；null = 不接受参数 */
  readonly argumentHint: string | null;
}

export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  {
    name: 'new',
    description: '在当前工作区新建会话',
    argumentHint: null,
  },
  {
    name: 'rename',
    description: '重命名当前会话',
    argumentHint: '新名称',
  },
  {
    name: 'archive',
    description: '归档当前会话（不在侧栏显示）',
    argumentHint: null,
  },
  {
    name: 'model',
    description: '切换模型（Provider Profile）',
    argumentHint: '名称关键词',
  },
  {
    name: 'status',
    description: '查看上下文用量与会话状态',
    argumentHint: null,
  },
];
