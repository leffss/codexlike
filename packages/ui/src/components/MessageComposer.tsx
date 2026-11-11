import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  parseComposerDraft,
  type ApprovalMode,
  type ProviderProfile,
  type SlashCommandDef,
  type SkillDescriptor,
} from "@codexlike/agent-core";

import {
  applyMentionSelection,
  applySkillSelection,
  computeMenu,
  handleMenuKey,
  type ComposerMenuState,
} from "../lib/composer-menu";

/** 审批模式 → 选择器文案（GLOSSARY「审批模式」三档：请求批准 / 帮我批准 / 完全访问） */
export const APPROVAL_MODE_OPTIONS: {
  value: ApprovalMode;
  label: string;
  title: string;
}[] = [
  {
    value: "ask",
    label: "请求批准",
    title: "ask：编辑文件、执行命令与联网搜索前先询问我",
  },
  {
    value: "assist",
    label: "帮我批准",
    title: "assist：文件编辑与联网自动放行，仅危险命令（rm、强推等）询问我",
  },
  {
    value: "full-access",
    label: "完全访问",
    title: "full-access：全自动执行，且可不受限读写本地任意文件（切换需确认）",
  },
];

/** 审批模式 → 底部工具栏胶囊样式：权限越高越暖色（full-access=琥珀） */
const APPROVAL_PILL_STYLES: Record<
  ApprovalMode,
  { pill: string; icon: string }
> = {
  ask: {
    pill: "border-info-fg/30 bg-info-bg text-info-fg",
    icon: "text-info-fg",
  },
  assist: {
    pill: "border-line bg-hover text-fg-muted",
    icon: "text-fg-muted",
  },
  "full-access": {
    pill: "border-warn-fg/40 bg-warn-bg text-warn-fg",
    icon: "text-warn-fg",
  },
};

/**
 * 中栏底部：消息输入区（卡片式 composer：上行输入、下行工具栏）。
 * - `/` 开头的单行草稿弹出命令菜单，`@` 触发工作区文件模糊搜索菜单（键盘可选）；
 * - 模型选择器（Provider Profile）对下一条发送的消息生效；
 * - 审批模式选择器随时可切，对下一次工具调用立即生效；
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
  /** 最新磁盘预览候选；打开技能菜单时重新发现，不沿用运行快照。 */
  skills?: readonly SkillDescriptor[];
  onOpenSkills?: () => void;
  /** 无会话 / 未选模型 / 流式回复中时禁用发送 */
  disabled: boolean;
  /** 本轮回复进行中（流式输出 / 工具执行）：按钮切换为「停止」 */
  streaming?: boolean;
  /** 停止按钮：打断运行中的本轮（立即中断流式输出、终止工具子进程） */
  onStop?: () => void;
  hint: string;
  /** 当前会话审批模式；无会话时选择器禁用 */
  approvalMode: ApprovalMode | null;
  onSelectApprovalMode: (mode: ApprovalMode) => void;
}) {
  const [value, setValue] = useState("");
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
      const openingSkills = draft.menu === "skills" && !skillMenuOpenRef.current;
      skillMenuOpenRef.current = draft.menu === "skills";
      setMenu(computeMenu(draft, { files: props.workspaceFiles, skills: props.skills }));
      if (openingSkills) props.onOpenSkills?.();
    },
    [props.workspaceFiles, props.skills, props.onOpenSkills]
  );

  // 异步候选到达时重算；Esc 关闭后不因刷新而重开。
  useEffect(() => {
    const caret = textareaRef.current?.selectionStart ?? value.length;
    syncMenu(value, caret);
  }, [props.workspaceFiles, props.skills]);

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
    if (text === "" || props.disabled) {
      return;
    }
    props.onSend(text);
    setValue("");
    setMenu(null);
    dismissedRef.current = null;
  }

  function selectItem(item: ComposerMenuState["items"][number], caretIndex: number) {
    if (menu === null) return;
    if (menu.kind === "skills") {
      const applied = applySkillSelection({ text: value, skillStart: menu.skillStart ?? 0, selectedName: (item as SkillDescriptor).name, caretIndex });
      commitText(applied.text, applied.caretIndex);
    } else if (menu.kind === "mentions") {
      const applied = applyMentionSelection({ text: value, mentionStart: menu.mentionStart ?? 0, selectedPath: item as string, caretIndex });
      commitText(applied.text, applied.caretIndex);
    } else {
      const command = item as SlashCommandDef;
      if (command.argumentHint === null) {
        setValue("");
        setMenu(null);
        dismissedRef.current = null;
        if (!props.disabled) props.onSend(`/${command.name}`);
      } else {
        commitText(`/${command.name} `, `/${command.name} `.length);
      }
    }
  }

  function openSkills() {
    dismissedRef.current = null;
    const caret = textareaRef.current?.selectionStart ?? value.length;
    if (parseComposerDraft(value, { caretIndex: caret }).menu === "skills") {
      skillMenuOpenRef.current = false;
      syncMenu(value, caret);
      textareaRef.current?.focus();
      return;
    }
    const prefix = value.slice(0, caret);
    const insertion = `${prefix === "" || /\s$/.test(prefix) ? "" : " "}$`;
    commitText(prefix + insertion + value.slice(caret), caret + insertion.length);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (menu !== null && !event.shiftKey) {
      const result = handleMenuKey(menu, event.key);
      if (result.action === "move") {
        event.preventDefault();
        setMenu({ ...menu, activeIndex: result.activeIndex });
        return;
      }
      if (result.action === "close") {
        event.preventDefault();
        const caret = event.currentTarget.selectionStart ?? value.length;
        dismissedRef.current = `${value.length}:${caret}:${value}`;
        skillMenuOpenRef.current = false;
        setMenu(null);
        return;
      }
      if (result.action === "select") {
        event.preventDefault();
        selectItem(result.item, event.currentTarget.selectionStart ?? value.length);
        return;
      }
    }

    // Enter 发送，Shift+Enter 换行
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  }

  const approvalPill =
    APPROVAL_PILL_STYLES[props.approvalMode ?? "assist"] ??
    APPROVAL_PILL_STYLES.assist;

  return (
    <div className="border-t border-line bg-surface-muted p-3">
      {/* 卡片式 composer：上行输入、下行工具栏（参考稿同构） */}
      <form
        className="rounded-2xl border border-line bg-surface shadow-lg transition-colors focus-within:border-fg-muted"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="relative">
          {menu !== null && (
            <ul
              data-testid="composer-menu"
              role="listbox"
              aria-label={menu.kind === "skills" ? "下轮技能预览" : "输入补全"}
              className="absolute bottom-full left-0 z-10 mb-2 max-h-56 w-full overflow-y-auto rounded-xl border border-line bg-surface shadow-xl"
            >
              {menu.items.map((item, index) => {
                const isCommand = menu.kind === "slash-commands";
                const command = isCommand ? (item as SlashCommandDef) : null;
                const skill = menu.kind === "skills" ? (item as SkillDescriptor) : null;
                const path = menu.kind === "mentions" ? (item as string) : null;
                return (
                  <li
                    key={command?.name ?? skill?.path ?? path}
                    role="option"
                    aria-selected={index === menu.activeIndex}
                    data-testid={skill ? `composer-skill-${skill.name}` : undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectItem(item, textareaRef.current?.selectionStart ?? value.length)}
                    className={
                      index === menu.activeIndex
                        ? "bg-selected px-3 py-1.5 text-sm text-fg"
                        : "px-3 py-1.5 text-sm text-fg-muted hover:bg-hover"
                    }
                  >
                    {command !== null ? (
                      <span className="flex items-baseline gap-2">
                        <code className="text-accent">/{command.name}</code>
                        <span className="text-xs text-fg-subtle">
                          {command.description}
                          {command.argumentHint !== null
                            ? `（参数：${command.argumentHint}）`
                            : ""}
                        </span>
                      </span>
                    ) : skill !== null ? (
                      <span className="block" title={skill.path}>
                        <code className="text-accent">${skill.name}</code>
                        <span className="ml-2 text-xs text-fg-muted">{skill.description}</span>
                        <span className="block truncate text-xs text-fg-subtle">
                          下轮预览 · {skill.scope === "project" ? "项目" : "全局"} · {skill.source} · {skill.path}
                        </span>
                      </span>
                    ) : (
                      <span
                        className="block truncate font-mono text-xs"
                        title={path ?? ""}
                      >
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
              const caret =
                event.target.selectionStart ?? event.target.value.length;
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
            className="max-h-64 min-h-11 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
          />
        </div>
        {/* 底部工具栏：左审批胶囊，右模型选择 + 圆形动作按钮 */}
        <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
          <div
            className={`relative shrink-0 rounded-full border ${approvalPill.pill} ${
              props.approvalMode === null ? "cursor-not-allowed opacity-50" : ""
            }`}
            title="审批模式：随时切换，对下一次工具调用立即生效"
          >
            <ShieldIcon
              className={`pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 ${approvalPill.icon}`}
            />
            <select
              data-testid="approval-mode-select"
              value={props.approvalMode ?? "assist"}
              disabled={props.approvalMode === null}
              onChange={(event) =>
                props.onSelectApprovalMode(event.target.value as ApprovalMode)
              }
              className="cursor-pointer appearance-none rounded-full bg-transparent py-1 pl-7 pr-5 text-xs focus:outline-none"
            >
              {APPROVAL_MODE_OPTIONS.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  title={option.title}
                >
                  {option.label}
                </option>
              ))}
            </select>
            <CaretDownIcon className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 opacity-60" />
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              data-testid="composer-skills"
              disabled={props.approvalMode === null}
              onClick={openSkills}
              className="shrink-0 rounded px-2 py-1 text-xs text-fg-muted hover:bg-hover hover:text-accent disabled:opacity-50"
              title="插入 $技能引用（仅写回输入框，不发送）"
            >
              技能
            </button>
            <div
              className="relative shrink-0"
              title="模型（Provider Profile）：对下一条消息生效"
            >
              <select
                data-testid="profile-select"
                value={props.selectedProfileId}
                onChange={(event) => props.onSelectProfile(event.target.value)}
                className="max-w-56 cursor-pointer appearance-none truncate bg-transparent py-1 pl-2 pr-6 text-xs text-fg-muted focus:outline-none"
              >
                {props.profiles.length === 0 && (
                  <option value="">未配置模型</option>
                )}
                {props.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} · {profile.model}
                  </option>
                ))}
              </select>
              <CaretDownIcon className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-60" />
            </div>
            {props.streaming === true ? (
              <button
                type="button"
                data-testid="composer-stop"
                onClick={() => props.onStop?.()}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger-solid text-on-accent hover:bg-danger-solid-hover"
                title="打断本轮回复：中断流式输出、终止正在执行的工具子进程"
              >
                <StopIcon className="h-3 w-3" />
              </button>
            ) : (
              <button
                type="submit"
                data-testid="composer-send"
                disabled={props.disabled}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-hover disabled:text-fg-subtle"
                title="发送（Enter 发送，Shift+Enter 换行）"
              >
                <ArrowUpIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

function ShieldIcon(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={props.className}
      aria-hidden="true"
    >
      <path
        d="M8 1.5 13 3.4V7c0 3.1-2.1 5.8-5 6.9C5.1 12.8 3 10.1 3 7V3.4L8 1.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CaretDownIcon(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={props.className}
      aria-hidden="true"
    >
      <path
        d="M4.5 6.5 8 10l3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ArrowUpIcon(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={props.className}
      aria-hidden="true"
    >
      <path
        d="M8 13V3.5M3.8 7.7 8 3.5l4.2 4.2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StopIcon(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={props.className}
      aria-hidden="true"
    >
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}
