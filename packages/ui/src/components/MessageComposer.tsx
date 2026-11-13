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
  type ThinkingEffort,
} from "@codexlike/agent-core";

import {
  applyMentionSelection,
  applySkillSelection,
  computeMenu,
  handleMenuKey,
  type ComposerMenuState,
} from "../lib/composer-menu";
import { SESSION_CONTENT_WIDTH_CLASS } from "../lib/content-width";
import { ComposerSelect } from "./ComposerSelect";
import { QueueBar } from "./QueueBar";
import type { QueuedMessage } from "@codexlike/desktop/ipc";

/** 审批模式 → 选择器文案（GLOSSARY「审批模式」三档：请求批准 / 帮我批准 / 完全访问） */
const APPROVAL_MODE_OPTIONS: {
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

/**
 * 思考档位（GLOSSARY「思考档位」）→ 胶囊选项文案。
 * 与 Provider Profile 选择一样属于「下一条消息怎么发」的临时设置：
 * 只对下一条发送的消息生效，不做会话级记忆；「关」是显式发送关闭请求，
 * 不保证强制思考模型实际停止思考（以服务端行为为准）。
 */
const THINKING_EFFORT_OPTIONS: {
  value: ThinkingEffort;
  label: string;
  title: string;
}[] = [
  {
    value: "auto",
    label: "思考：自动",
    title: "自动：不附加控制参数，由服务端决定思考行为（默认）",
  },
  {
    value: "low",
    label: "思考：低",
    title: "低：请求较浅的思考强度（下一条消息生效）",
  },
  {
    value: "medium",
    label: "思考：中",
    title: "中：请求中等思考强度（下一条消息生效）",
  },
  {
    value: "high",
    label: "思考：高",
    title: "高：请求更深思考强度（下一条消息生效）",
  },
  {
    value: "off",
    label: "思考：关",
    title: "关：显式请求关闭思考；服务端可能忽略，不保证强制停止",
  },
];

/**
 * 中栏底部：消息输入区（卡片式 composer：上行输入、下行工具栏）。
 * - `/` 开头的单行草稿弹出命令菜单，`@` 触发工作区文件模糊搜索菜单（键盘可选）；
 * - 模型选择器（Provider Profile）对下一条发送的消息生效；
 * - 审批模式选择器随时可切，只对下一次发送生效；
 * - 发送内容（命令或消息）由上层用 resolveComposerSubmission 分发；
 * - 本轮回复进行中（流式输出或工具执行）时发送按钮切换为「停止」，打断当前轮。
 */
export function MessageComposer(props: {
  /** 草稿由 App 按会话保存；未传时保持独立使用能力。 */
  draftValue?: string;
  onDraftChange?: (text: string) => void;
  profiles: ProviderProfile[];
  selectedProfileId: string;
  onSelectProfile: (id: string) => void;
  onSend: (text: string) => void;
  /** 受控草稿由父级在发送确认后清空，失败则保留输入。 */
  clearOnSend?: boolean;
  /** @引用 菜单候选（工作区文件） */
  workspaceFiles: string[];
  /** 最新磁盘预览候选；打开技能菜单时重新发现，不沿用运行快照。 */
  skills?: readonly SkillDescriptor[];
  onOpenSkills?: () => void;
  /** 无会话 / 未选模型 / 流式回复中时禁用发送 */
  disabled: boolean;
  /** 恢复中或首次发送消费草稿期间不允许编辑；运行中仍可准备下一条。 */
  readOnly?: boolean;
  /** 本轮回复进行中（流式输出 / 工具执行）：按钮切换为「停止」 */
  streaming?: boolean;
  /** 停止按钮：打断运行中的本轮（立即中断流式输出、终止工具子进程） */
  onStop?: () => void;
  hint: string;
  /** 当前会话审批模式；无会话时选择器禁用 */
  approvalMode: ApprovalMode | null;
  onSelectApprovalMode: (mode: ApprovalMode) => void;
  /**
   * 思考档位（GLOSSARY「思考档位」）当前选择：逐条消息的临时发送设置，
   * 只对下一条发送的消息生效；null（无会话）时选择器禁用。
   * 回复运行中允许改选（为下一条消息预置）。
   */
  thinkingEffort: ThinkingEffort | null;
  onSelectThinkingEffort: (effort: ThinkingEffort) => void;
  /**
   * 内容列宽度类（票 05 容器分档宽度）：与消息流、头部共用同一内容列
   * （空态 2xl / 有内容三档由 WorkspacePage 单点选择下发）。
   */
  contentWidthClass?: string;
  /** 当前会话的输入队列（票 01）：输入框上方只读队列条；空时不渲染 */
  queue?: QueuedMessage[];
}) {
  const contentWidthClass =
    props.contentWidthClass ?? SESSION_CONTENT_WIDTH_CLASS;
  const [localValue, setLocalValue] = useState("");
  const value = props.draftValue ?? localValue;
  function setValue(next: string) {
    setLocalValue(next);
    props.onDraftChange?.(next);
  }
  const [menu, setMenu] = useState<ComposerMenuState | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** Esc 关闭菜单的签名（value + 光标）：draft 未变化前不再自动弹出 */
  const dismissedRef = useRef<string | null>(null);
  const skillMenuOpenRef = useRef(false);

  // 解构到局部：syncMenu 回调只依赖这三个属性，直接引用 props 对象
  // 会让 exhaustive-deps 无法核对（props 每次渲染都是新引用）。
  const { workspaceFiles, skills, onOpenSkills } = props;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只监听候选集到达：value/光标变化由 commitText 显式 syncMenu，补全 value 会让每次按键都重算菜单
  }, [workspaceFiles, skills]);

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
    // 空白检查不改原文；提交解析层决定 trim，避免破坏 Markdown 代码缩进。
    const text = value;
    if (text.trim() === "" || props.disabled) {
      return;
    }
    props.onSend(text);
    if (props.clearOnSend !== false) setValue("");
    setMenu(null);
    dismissedRef.current = null;
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
    commitText(
      prefix + insertion + value.slice(caret),
      caret + insertion.length
    );
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
        selectItem(
          result.item,
          event.currentTarget.selectionStart ?? value.length
        );
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

  return (
    // 补偿消息流原生滚动条占宽，基准列对齐后输入卡片左右各外扩 8px。
    <div
      data-testid="composer-region"
      className="bg-canvas px-4 py-3"
      style={{
        paddingRight: "calc(1rem + var(--session-scrollbar-gutter, 0px))",
      }}
    >
      <div className={contentWidthClass}>
        {/* 输入队列条（票 01）：输入框上方只读预览，回复结束后自动逐条发出 */}
        <QueueBar queue={props.queue ?? []} />
        {/* 卡片式 composer：上行输入、下行工具栏（参考稿同构） */}
        <form
          data-testid="composer-card"
          className="-mx-2 rounded-2xl border border-line bg-surface shadow-lg transition-colors focus-within:border-fg-muted"
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
                aria-label={
                  menu.kind === "skills" ? "下轮技能预览" : "输入补全"
                }
                className="absolute bottom-full left-0 z-10 mb-2 max-h-56 w-full overflow-y-auto rounded-xl border border-line bg-surface shadow-xl"
              >
                {menu.items.map((item, index) => {
                  const isCommand = menu.kind === "slash-commands";
                  const command = isCommand ? (item as SlashCommandDef) : null;
                  const skill =
                    menu.kind === "skills" ? (item as SkillDescriptor) : null;
                  const path =
                    menu.kind === "mentions" ? (item as string) : null;
                  return (
                    <li
                      key={command?.name ?? skill?.path ?? path}
                      role="option"
                      aria-selected={index === menu.activeIndex}
                      data-testid={
                        skill ? `composer-skill-${skill.name}` : undefined
                      }
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() =>
                        selectItem(
                          item,
                          textareaRef.current?.selectionStart ?? value.length
                        )
                      }
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
                          <span className="ml-2 text-xs text-fg-muted">
                            {skill.description}
                          </span>
                          <span className="block truncate text-xs text-fg-subtle">
                            下轮预览 ·{" "}
                            {skill.scope === "project" ? "项目" : "全局"} ·{" "}
                            {skill.source} · {skill.path}
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
              readOnly={props.readOnly}
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
                const caret =
                  event.currentTarget.selectionStart ?? value.length;
                syncMenu(value, caret);
              }}
              onKeyDown={onKeyDown}
              placeholder={props.hint}
              rows={2}
              className="max-h-64 min-h-11 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
            />
          </div>
          {/* 底部工具栏：左审批模式，右模型 → 思考档位 → 技能 → 动作按钮。 */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2.5">
            <div className="flex items-center gap-2">
              <ComposerSelect
                testId="approval-mode-select"
                label="审批模式"
                value={props.approvalMode ?? "assist"}
                disabled={props.readOnly || props.approvalMode === null}
                options={APPROVAL_MODE_OPTIONS}
                onSelect={props.onSelectApprovalMode}
                renderIcon={(mode) => (
                  <ApprovalModeIcon
                    mode={mode}
                    className={`h-3 w-3 ${mode === "full-access" ? "text-warn-fg" : ""}`}
                  />
                )}
              />
            </div>
            <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
              <ComposerSelect
                testId="profile-select"
                label="模型"
                value={props.selectedProfileId}
                disabled={props.readOnly}
                options={[
                  ...(props.profiles.length === 0
                    ? [{ value: "", label: "未配置模型", title: "未配置模型" }]
                    : []),
                  ...(props.selectedProfileId &&
                  !props.profiles.some(
                    (profile) => profile.id === props.selectedProfileId
                  )
                    ? [
                        {
                          value: props.selectedProfileId,
                          label: "已保存的模型不可用",
                          title: "已保存的模型不可用，请重新选择模型",
                        },
                      ]
                    : []),
                  ...props.profiles.map((profile) => ({
                    value: profile.id,
                    label: `${profile.name} · ${profile.model}`,
                    title: `${profile.name} · ${profile.model}（对下一条消息生效）`,
                  })),
                ]}
                onSelect={props.onSelectProfile}
                className="min-w-0 max-w-56 shrink"
              />
              {/* 无会话禁用；运行中允许改选，只对下一条消息生效。 */}
              <ComposerSelect
                testId="thinking-effort-select"
                label="思考档位"
                value={props.thinkingEffort ?? "auto"}
                disabled={props.readOnly || props.thinkingEffort === null}
                options={THINKING_EFFORT_OPTIONS}
                onSelect={props.onSelectThinkingEffort}
                renderIcon={() => <BrainIcon className="h-3 w-3" />}
              />
              <button
                type="button"
                data-testid="composer-skills"
                disabled={props.readOnly || props.approvalMode === null}
                onClick={openSkills}
                className="shrink-0 rounded px-2 py-1 text-xs text-fg-muted hover:bg-hover hover:text-accent disabled:opacity-50"
                title="插入 $技能引用（仅写回输入框，不发送）"
              >
                技能
              </button>
              {props.streaming === true ? (
                <button
                  type="button"
                  data-testid="composer-stop"
                  onClick={() => props.onStop?.()}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger-solid text-on-accent hover:bg-danger-solid-hover"
                  title="打断本轮回复：中断流式输出、终止正在执行的工具子进程"
                >
                  <StopIcon className="h-5 w-5" />
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
    </div>
  );
}

function ApprovalModeIcon(props: { mode: ApprovalMode; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={props.className}
      aria-hidden="true"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {props.mode === "full-access" ? (
        <>
          <path d="M6 7V4a3 3 0 0 1 6 0" />
          <rect x="3" y="7" width="10" height="7" rx="1.5" />
          <path d="M8 10v1" />
        </>
      ) : (
        <>
          <path d="M8 1.5 13 3.4V7c0 3.1-2.1 5.8-5 6.9C5.1 12.8 3 10.1 3 7V3.4L8 1.5Z" />
          {props.mode === "ask" ? (
            <>
              <path d="M6.5 6a1.5 1.5 0 0 1 3 0c0 1-1.5 1-1.5 2" />
              <circle
                cx="8"
                cy="10.5"
                r="0.75"
                fill="currentColor"
                stroke="none"
              />
            </>
          ) : (
            <path d="m5.5 7.5 1.5 1.5 3.5-3.5" />
          )}
        </>
      )}
    </svg>
  );
}

function BrainIcon(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={props.className}
      aria-hidden="true"
    >
      <path
        d="M6 2.5a2 2 0 0 0-2 2c-1.1.2-2 1.1-2 2.3 0 .8.4 1.5 1 1.9v.6c0 1.7 1.3 3.2 3 3.2h1V2.5H6ZM10 2.5a2 2 0 0 1 2 2c1.1.2 2 1.1 2 2.3 0 .8-.4 1.5-1 1.9v.6c0 1.7-1.3 3.2-3 3.2H9V2.5h1Z"
        stroke="currentColor"
        strokeWidth="1.2"
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
      <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  );
}
