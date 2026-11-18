import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

import {
  parseComposerDraft,
  type SkillDescriptor,
  type SlashCommandDef,
} from "@codexlike/agent-core";

import {
  applyMentionSelection,
  applySkillSelection,
  computeMenu,
  handleMenuKey,
  type ComposerMenuState,
} from "./composer-menu";

/**
 * composer 菜单宿主（`/`·`@`·`$` 三菜单的输入框状态机）：菜单计算、
 * Esc 关闭签名、技能打开上报、候选到达重算、选中写回（含 rAF 光标
 * 归位）与键盘导航，一次收拢为 MessageComposer 与 NewTaskStart
 * StartComposer 共用（此前两侧逐行同构维护）。纯函数核心仍在
 * `composer-menu.ts`，本 hook 只补组件态：受控文本经 onTextCommit
 * 写回、提交许可（任务态 disabled / 新建态 busy）经 canSubmit 传入。
 */
export interface UseComposerMenuOptions {
  /** 当前输入文本（受控值） */
  value: string;
  /** 文本写回（输入变更 / 菜单补全 / 无参命令清空共用一条路径） */
  onTextCommit: (next: string) => void;
  /** 无参斜杠命令选中即提交（selectItem 第三分支） */
  onSend: (text: string) => void;
  /** 提交许可：仅约束无参命令直发（MessageComposer 传 !disabled、StartComposer 传 !busy） */
  canSubmit: boolean;
  /** @引用 菜单候选（工作区文件） */
  workspaceFiles: readonly string[];
  /** 技能候选（$ 菜单） */
  skills?: readonly SkillDescriptor[];
  /** 打开技能菜单时重新发现（不沿用运行快照） */
  onOpenSkills?: () => void;
}

/** 菜单宿主句柄：textarea 接线（onChange/onClick/onKeyDown）与菜单渲染所需的最小面 */
export interface ComposerMenuController {
  menu: ComposerMenuState | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** 显式重算菜单；Esc 关闭签名匹配时不重开 */
  syncMenu: (text: string, caretIndex: number) => void;
  /** 写回文本 + 清 Esc 签名 + 重算菜单 + rAF 聚焦并归位光标 */
  commitText: (next: string, caretIndex: number) => void;
  /** 输入变更（textarea onChange）：写回 + 清 Esc 签名 + 按新文本/光标重算 */
  handleTyping: (text: string, caretIndex: number) => void;
  /** 菜单项选中（键盘/点击）：技能/引用补全写回，或无参命令直发 */
  selectItem: (
    item: ComposerMenuState["items"][number],
    caretIndex: number
  ) => void;
  /** 键盘菜单导航（↑↓/Enter/Tab/Esc）；返回是否已消费该键（false 时落入组件其余键处理） */
  handleMenuKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** 强制重开（技能按钮）：清 Esc 签名并重报技能菜单打开（onOpenSkills 再触发） */
  reopenMenu: (text: string, caretIndex: number) => void;
  /** 提交后收菜单（清菜单态与 Esc 签名） */
  resetMenu: () => void;
}

export function useComposerMenu(
  options: UseComposerMenuOptions
): ComposerMenuController {
  const {
    value,
    onTextCommit,
    onSend,
    canSubmit,
    workspaceFiles,
    skills,
    onOpenSkills,
  } = options;
  const [menu, setMenu] = useState<ComposerMenuState | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** Esc 关闭菜单的签名（value + 光标）：draft 未变化前不再自动弹出 */
  const dismissedRef = useRef<string | null>(null);
  const skillMenuOpenRef = useRef(false);

  const syncMenu = useCallback(
    (text: string, caretIndex: number) => {
      const signature = `${text.length}:${caretIndex}:${text}`;
      if (dismissedRef.current === signature) {
        return;
      }
      const draft = parseComposerDraft(text, { caretIndex });
      const openingSkills =
        draft.menu === "skills" && !skillMenuOpenRef.current;
      skillMenuOpenRef.current = draft.menu === "skills";
      setMenu(
        computeMenu(draft, {
          files: workspaceFiles,
          skills,
        })
      );
      if (openingSkills) onOpenSkills?.();
    },
    [workspaceFiles, skills, onOpenSkills]
  );

  // 异步候选到达时重算；Esc 关闭后不因刷新而重开。
  useEffect(() => {
    const caret = textareaRef.current?.selectionStart ?? value.length;
    syncMenu(value, caret);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只监听候选集到达：value/光标变化由 handleTyping/commitText 显式 syncMenu，补全 value 会让每次按键都重算菜单
  }, [workspaceFiles, skills]);

  function commitText(next: string, caretIndex: number) {
    onTextCommit(next);
    dismissedRef.current = null;
    syncMenu(next, caretIndex);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caretIndex, caretIndex);
    });
  }

  function handleTyping(text: string, caretIndex: number) {
    onTextCommit(text);
    dismissedRef.current = null;
    syncMenu(text, caretIndex);
  }

  function selectItem(
    item: ComposerMenuState["items"][number],
    caretIndex: number
  ) {
    if (menu === null) return;
    if (menu.kind === "skills") {
      const applied = applySkillSelection({
        text: value,
        skillStart: menu.skillStart ?? 0,
        selectedName: (item as SkillDescriptor).name,
        caretIndex,
      });
      commitText(applied.text, applied.caretIndex);
    } else if (menu.kind === "mentions") {
      const applied = applyMentionSelection({
        text: value,
        mentionStart: menu.mentionStart ?? 0,
        selectedPath: item as string,
        caretIndex,
      });
      commitText(applied.text, applied.caretIndex);
    } else {
      const command = item as SlashCommandDef;
      if (command.argumentHint === null) {
        // 无参命令选中即提交，清空输入防重复
        onTextCommit("");
        setMenu(null);
        dismissedRef.current = null;
        if (canSubmit) onSend(`/${command.name}`);
      } else {
        commitText(`/${command.name} `, `/${command.name} `.length);
      }
    }
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (menu === null || event.shiftKey) return false;
    const result = handleMenuKey(menu, event.key);
    if (result.action === "move") {
      event.preventDefault();
      setMenu({ ...menu, activeIndex: result.activeIndex });
      return true;
    }
    if (result.action === "close") {
      event.preventDefault();
      const caret = event.currentTarget.selectionStart ?? value.length;
      dismissedRef.current = `${value.length}:${caret}:${value}`;
      skillMenuOpenRef.current = false;
      setMenu(null);
      return true;
    }
    if (result.action === "select") {
      event.preventDefault();
      selectItem(
        result.item,
        event.currentTarget.selectionStart ?? value.length
      );
      return true;
    }
    return false;
  }

  function reopenMenu(text: string, caretIndex: number) {
    dismissedRef.current = null;
    skillMenuOpenRef.current = false;
    syncMenu(text, caretIndex);
  }

  function resetMenu() {
    setMenu(null);
    dismissedRef.current = null;
  }

  return {
    menu,
    textareaRef,
    syncMenu,
    commitText,
    handleTyping,
    selectItem,
    handleMenuKeyDown,
    reopenMenu,
    resetMenu,
  };
}
