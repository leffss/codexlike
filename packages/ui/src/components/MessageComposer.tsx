import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import {
  parseComposerDraft,
  type ProviderProfile,
  type SlashCommandDef,
} from '@codexlike/agent-core';

import {
  applyMentionSelection,
  computeMenu,
  handleMenuKey,
  type ComposerMenuState,
} from '../lib/composer-menu';

/**
 * 中栏底部：消息输入区。
 * - `/` 开头的单行草稿弹出命令菜单，`@` 触发工作区文件模糊搜索菜单（键盘可选）；
 * - 模型选择器（Provider Profile）对下一条发送的消息生效；
 * - 发送内容（命令或消息）由上层用 resolveComposerSubmission 分发；
 * - 本轮回复进行中（流式输出或工具执行）时发送按钮切换为「停止」，打断当前轮。
 */
export function MessageComposer(props: {
  profiles: ProviderProfile[];
  selectedProfileId: string;
  onSelectProfile: (id: string) => void;
  onSend: (text: string) => void;
  /** @引用 菜单候选（工作区文件） */
  workspaceFiles: string[];
  /** 无会话 / 未选模型 / 流式回复中时禁用发送 */
  disabled: boolean;
  /** 本轮回复进行中（流式输出 / 工具执行）：按钮切换为「停止」 */
  streaming?: boolean;
  /** 停止按钮：打断运行中的本轮（立即中断流式输出、终止工具子进程） */
  onStop?: () => void;
  hint: string;
}) {
  const [value, setValue] = useState('');
  const [menu, setMenu] = useState<ComposerMenuState | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** Esc 关闭菜单的签名（value + 光标）：draft 未变化前不再自动弹出 */
  const dismissedRef = useRef<string | null>(null);

  const syncMenu = useCallback(
    (text: string, caretIndex: number) => {
      const signature = `${text.length}:${caretIndex}:${text}`;
      if (dismissedRef.current === signature) {
        return;
      }
      const draft = parseComposerDraft(text, { caretIndex });
      setMenu(computeMenu(draft, { files: props.workspaceFiles }));
    },
    [props.workspaceFiles],
  );

  // 候选文件列表变化（切会话）时重算当前菜单（value/syncMenu 刻意不入依赖）
  useEffect(() => {
    const caret = textareaRef.current?.selectionStart ?? value.length;
    dismissedRef.current = null;
    syncMenu(value, caret);
  }, [props.workspaceFiles]);

  function commitText(next: string, caretIndex: number) {
    setValue(next);
    dismissedRef.current = null;
    syncMenu(next, caretIndex);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caretIndex, caretIndex);
    });
  }

  function submit() {
    const text = value.trim();
    if (text === '' || props.disabled) {
      return;
    }
    props.onSend(text);
    setValue('');
    setMenu(null);
    dismissedRef.current = null;
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (menu !== null) {
      const result = handleMenuKey(menu, event.key);
      if (result.action === 'move') {
        event.preventDefault();
        setMenu({ ...menu, activeIndex: result.activeIndex });
        return;
      }
      if (result.action === 'close') {
        event.preventDefault();
        const caret = event.currentTarget.selectionStart ?? value.length;
        dismissedRef.current = `${value.length}:${caret}:${value}`;
        setMenu(null);
        return;
      }
      if (result.action === 'select') {
        event.preventDefault();
        if (menu.kind === 'slash-commands') {
          const command = result.item as SlashCommandDef;
          if (command.argumentHint === null) {
            // 无参命令：选中即执行（免二次 Enter）
            setValue('');
            setMenu(null);
            dismissedRef.current = null;
            if (!props.disabled) {
              props.onSend(`/${command.name}`);
            }
          } else {
            // 带参命令：回填 `/命令 ` 继续输入参数
            commitText(`/${command.name} `, `/${command.name} `.length);
          }
        } else {
          const caret = event.currentTarget.selectionStart ?? value.length;
          const applied = applyMentionSelection({
            text: value,
            mentionStart: menu.mentionStart ?? 0,
            selectedPath: result.item as string,
            caretIndex: caret,
          });
          commitText(applied.text, applied.caretIndex);
        }
        return;
      }
    }

    // Enter 发送，Shift+Enter 换行
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="border-t border-slate-800 bg-slate-900/60 p-3">
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <select
          data-testid="profile-select"
          value={props.selectedProfileId}
          onChange={(event) => props.onSelectProfile(event.target.value)}
          className="h-11 shrink-0 rounded-lg border border-slate-700 bg-slate-950/70 px-2 text-xs text-slate-200"
          title="模型（Provider Profile）：对下一条消息生效"
        >
          {props.profiles.length === 0 && <option value="">未配置模型</option>}
          {props.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} · {profile.model}
            </option>
          ))}
        </select>
        <div className="relative min-w-0 flex-1">
          {menu !== null && (
            <ul
              data-testid="composer-menu"
              className="absolute bottom-full left-0 z-10 mb-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 shadow-lg"
            >
              {menu.items.map((item, index) => {
                const isCommand = menu.kind === 'slash-commands';
                const command = isCommand ? (item as SlashCommandDef) : null;
                const path = isCommand ? null : (item as string);
                return (
                  <li
                    key={isCommand ? command!.name : path}
                    className={
                      index === menu.activeIndex
                        ? 'bg-sky-800/60 px-3 py-1.5 text-sm text-slate-100'
                        : 'px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800/70'
                    }
                  >
                    {command !== null ? (
                      <span className="flex items-baseline gap-2">
                        <code className="text-sky-300">/{command.name}</code>
                        <span className="text-xs text-slate-500">
                          {command.description}
                          {command.argumentHint !== null
                            ? `（参数：${command.argumentHint}）`
                            : ''}
                        </span>
                      </span>
                    ) : (
                      <span className="block truncate font-mono text-xs" title={path ?? ''}>
                        {path}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <textarea
            ref={textareaRef}
            data-testid="composer-input"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              const caret = event.target.selectionStart ?? event.target.value.length;
              dismissedRef.current = null;
              syncMenu(event.target.value, caret);
            }}
            onClick={(event) => {
              const caret = event.currentTarget.selectionStart ?? value.length;
              syncMenu(value, caret);
            }}
            onKeyDown={onKeyDown}
            placeholder={props.hint}
            rows={2}
            className="min-h-11 w-full resize-none rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
          />
        </div>
        {props.streaming === true ? (
          <button
            type="button"
            data-testid="composer-stop"
            onClick={() => props.onStop?.()}
            className="rounded-lg bg-red-700 px-4 py-2 text-sm text-white hover:bg-red-600"
            title="打断本轮回复：中断流式输出、终止正在执行的工具子进程"
          >
            停止
          </button>
        ) : (
          <button
            type="submit"
            data-testid="composer-send"
            disabled={props.disabled}
            className="rounded-lg bg-sky-700 px-4 py-2 text-sm text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            发送
          </button>
        )}
      </form>
    </div>
  );
}
