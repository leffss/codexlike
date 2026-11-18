import { useState, type KeyboardEvent } from "react";

import {
  parseComposerDraft,
  type ApprovalMode,
  type ProviderProfile,
  type SkillDescriptor,
  type ThinkingEffort,
} from "@codexlike/agent-core";

import { useComposerMenu } from "../lib/use-composer-menu";
import { APPROVAL_MODE_OPTIONS } from "../lib/composer-options";
import { ComposerSelect } from "./ComposerSelect";
import { ComposerMenuList } from "./ComposerMenuList";
import { ComposerRegion } from "./ComposerRegion";
import { ApprovalModeIcon, ArrowUpIcon } from "./ComposerIcons";
import { ModelThinkingSelect } from "./ModelThinkingSelect";
import { QueueBar } from "./QueueBar";
import type { QueuedMessage, QueueSnapshot } from "@codexlike/desktop/ipc";

/**
 * 中栏底部：消息输入区（卡片式 composer：上行输入、下行工具栏）。
 * - `/` 开头的单行草稿弹出命令菜单，`@` 触发工作区文件模糊搜索菜单（键盘可选）；
 * - 模型与思考档位统一选择器（ADR 0024 呈现修订）：单入口「模型名 · 档位」，
 *   弹层内点模型/档位分别经 onSelectModel / onSelectThinkingEffort 即时保存，
 *   均只对下一条发送的消息生效；
 * - 审批模式选择器随时可切，只对下一次发送生效；
 * - 发送内容（命令或消息）由上层用 resolveComposerSubmission 分发；
 * - 本轮回复进行中（流式输出或工具执行）：有输入时显示「加入队列」与「停止」
 *   并排双按钮（票 05，与 Enter 同一提交路径），无输入时仅「停止」；空闲为单发送按钮。
 */
export function MessageComposer(props: {
  /** 草稿由 App 按任务保存；未传时保持独立使用能力。 */
  draftValue?: string;
  onDraftChange?: (text: string) => void;
  profiles: ProviderProfile[];
  selectedProfileId: string;
  /**
   * 当前所选具体模型（票 02，ADR 0024 二元组）：null/undefined = 未显式选
   * （旧任务恢复前的显示回退、新建默认），选择器选中态落在 Profile 第一项。
   */
  selectedModel?: string | null;
  /** 选中「Profile · 模型」组合（票 02 平铺选择） */
  onSelectModel: (profileId: string, model: string) => void;
  onSend: (text: string) => void;
  /** 受控草稿由父级在发送确认后清空，失败则保留输入。 */
  clearOnSend?: boolean;
  /** @引用 菜单候选（工作区文件） */
  workspaceFiles: string[];
  /** 最新磁盘预览候选；打开技能菜单时重新发现，不沿用运行快照。 */
  skills?: readonly SkillDescriptor[];
  onOpenSkills?: () => void;
  /** 无任务 / 未选模型 / 流式回复中时禁用发送 */
  disabled: boolean;
  /** 恢复中或首次发送消费草稿期间不允许编辑；运行中仍可准备下一条。 */
  readOnly?: boolean;
  /** 本轮回复进行中（流式输出 / 工具执行）：按钮切换为「停止」 */
  streaming?: boolean;
  /** 停止按钮：打断运行中的本轮（立即中断流式输出、终止工具子进程） */
  onStop?: () => void;
  hint: string;
  /** 当前任务审批模式；无任务时选择器禁用 */
  approvalMode: ApprovalMode | null;
  onSelectApprovalMode: (mode: ApprovalMode) => void;
  /**
   * 思考档位（GLOSSARY「思考档位」）当前选择：任务独立记忆、重启后保留，
   * 调整只对下一次发送生效，不改变已开始的执行或历史；null（无任务）时
   * 整个统一选择器禁用（与审批/技能同源，见下方接线）。回复运行中允许改选
   * （为下一条消息预置）。
   */
  thinkingEffort: ThinkingEffort | null;
  onSelectThinkingEffort: (effort: ThinkingEffort) => void;
  /**
   * 内容列宽度类（票 05 容器分档宽度）：与消息流、头部共用同一内容列
   * （空态 2xl / 有内容三档由 WorkspacePage 单点选择下发）。
   */
  contentWidthClass?: string;
  /**
   * 当前任务的输入队列状态（票 01/02/03，review 重构收拢三元组）：
   * 排队条目 + 暂停标志 + 正在发出条目；队列空时队列条不渲染。
   */
  queueState?: QueueSnapshot;
  /** 编辑中的条目 id（票 03）：队列条高亮并显示取消入口 */
  queueEditingItemId?: string | null;
  /** 手动恢复队列消费（票 02） */
  onQueueResume?: () => void;
  /** 清空队列（票 02） */
  onQueueClear?: () => void;
  /** 删除单条排队消息（票 03） */
  onQueueRemove?: (itemId: string) => void;
  /** 点击排队消息取回编辑（票 03）：内容载入输入框 */
  onQueueEditItem?: (item: QueuedMessage) => void;
  /** 拖拽重排（票 03）：提交仍在排队条目的完整新顺序 */
  onQueueReorder?: (orderedIds: string[]) => void;
  /** 取消编辑（票 03）：条目原样保留，输入框还原先前草稿；按钮与 Esc 共用 */
  onQueueCancelEdit?: () => void;
}) {
  const [localValue, setLocalValue] = useState("");
  const value = props.draftValue ?? localValue;
  function setValue(next: string) {
    setLocalValue(next);
    props.onDraftChange?.(next);
  }
  // `/`·`@`·`$` 菜单宿主：状态机与键盘导航收拢在 useComposerMenu
  //（与 NewTaskStart StartComposer 共用），本组件只保留任务态键处理与提交。
  const {
    menu,
    textareaRef,
    syncMenu,
    commitText,
    handleTyping,
    selectItem,
    handleMenuKeyDown,
    reopenMenu,
    resetMenu,
  } = useComposerMenu({
    value,
    onTextCommit: setValue,
    onSend: props.onSend,
    canSubmit: !props.disabled,
    workspaceFiles: props.workspaceFiles,
    skills: props.skills,
    onOpenSkills: props.onOpenSkills,
  });

  function submit() {
    // 空白检查不改原文；提交解析层决定 trim，避免破坏 Markdown 代码缩进。
    const text = value;
    if (text.trim() === "" || props.disabled) {
      return;
    }
    props.onSend(text);
    if (props.clearOnSend !== false) setValue("");
    resetMenu();
  }

  function openSkills() {
    const caret = textareaRef.current?.selectionStart ?? value.length;
    if (parseComposerDraft(value, { caretIndex: caret }).menu === "skills") {
      reopenMenu(value, caret);
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
    if (handleMenuKeyDown(event)) return;

    // Esc 取消取回编辑（票 03）：菜单已关时才生效（菜单优先用 Esc 关闭）。
    // 正在编辑由 queueEditingItemId 派生（review 重构），取消入口单数化。
    if (
      event.key === "Escape" &&
      menu === null &&
      props.queueEditingItemId != null
    ) {
      event.preventDefault();
      props.onQueueCancelEdit?.();
      return;
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

  // 停止按钮（review 重构提取）：「编辑中」与「流式进行中」两个分支共用同一
  // 形态（危险色圆形、行尾位置）；空闲时不渲染。
  const stopButton =
    props.streaming === true ? (
      <button
        type="button"
        data-testid="composer-stop"
        onClick={() => props.onStop?.()}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger-solid text-on-accent hover:bg-danger-solid-hover"
        title="打断本轮回复：中断流式输出、终止正在执行的工具子进程"
      >
        <StopIcon className="h-5 w-5" />
      </button>
    ) : null;

  return (
    // 外壳（画布背景 / px-4 py-3 / 滚动槽右缘补偿 / contentWidthClass 居中
    // 收窄 / @container 基准）收拢进 ComposerRegion，与交互面板共用同一
    // 插槽外壳，宽度完全一致（2026-11-19 交互面板整合轮）。
    <ComposerRegion
      testId="composer-region"
      contentWidthClass={props.contentWidthClass}
    >
      {/* 输入队列条（票 01/02）：输入框上方只读预览，回复结束后自动逐条发出；
            暂停态（停止保留队列）显示「恢复」「清空」操作 */}
      <QueueBar
        queueState={props.queueState}
        editingItemId={props.queueEditingItemId}
        onResume={props.onQueueResume}
        onClear={props.onQueueClear}
        onRemove={props.onQueueRemove}
        onEditItem={props.onQueueEditItem}
        onReorder={props.onQueueReorder}
        onCancelEdit={props.onQueueCancelEdit}
      />
      {/* 卡片式 composer：上行输入、下行工具栏（参考稿同构） */}
      <form
        data-testid="composer-card"
        className="rounded-2xl border border-line bg-surface shadow-lg transition-colors focus-within:border-fg-muted"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="relative">
          {menu !== null && (
            <ComposerMenuList
              menu={menu}
              onSelectItem={selectItem}
              caretIndex={() =>
                textareaRef.current?.selectionStart ?? value.length
              }
            />
          )}
          <textarea
            ref={textareaRef}
            readOnly={props.readOnly}
            data-testid="composer-input"
            value={value}
            onChange={(event) => {
              handleTyping(
                event.target.value,
                event.target.selectionStart ?? event.target.value.length
              );
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
        {/* 底部工具栏：左审批模式，右模型 → 思考档位 → 技能 → 动作按钮。
              内容列 <560px（窗口收窄或右栏挤压）时降级为两行流式：审批整行
              左对齐、其余从左换行——两端分布在放不下时会把两行错开成斜的
              （审批独占一行、右组右对齐起点更靠右），流式才整齐。 */}
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2.5 @min-[560px]:justify-between">
          <div className="flex w-full min-w-0 items-center gap-2 @min-[560px]:w-auto">
            <ComposerSelect
              testId="approval-mode-select"
              label="审批模式"
              value={props.approvalMode ?? "assist"}
              disabled={props.readOnly || props.approvalMode === null}
              options={APPROVAL_MODE_OPTIONS}
              onSelect={props.onSelectApprovalMode}
              className="min-w-0 shrink"
              renderIcon={(mode) => (
                <ApprovalModeIcon
                  mode={mode}
                  className={`h-3 w-3 ${mode === "full-access" ? "text-warn-fg" : ""}`}
                />
              )}
            />
          </div>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 @min-[560px]:ml-auto @min-[560px]:w-auto @min-[560px]:justify-end">
            {/* 模型与思考统一选择器（ADR 0024 呈现修订）：单入口收起
                  「模型名 · 档位」；无任务（approvalMode=null）与恢复中整体
                  禁用（与审批/技能同源），运行中允许改选，只对下一条消息生效。 */}
            <ModelThinkingSelect
              className="min-w-0 max-w-56 shrink"
              profiles={props.profiles}
              selectedProfileId={props.selectedProfileId}
              selectedModel={props.selectedModel}
              thinkingEffort={props.thinkingEffort}
              disabled={props.readOnly || props.approvalMode === null}
              onSelectModel={props.onSelectModel}
              onSelectThinkingEffort={props.onSelectThinkingEffort}
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
            {props.queueEditingItemId != null ? (
              <>
                {/* 票 03：取回编辑中的主操作——保存原地更新，取消保留原文并还原草稿 */}
                <button
                  type="button"
                  data-testid="composer-cancel-edit"
                  onClick={() => props.onQueueCancelEdit?.()}
                  className="h-8 shrink-0 rounded-full border border-line px-3 text-xs text-fg-muted hover:bg-hover"
                  title="取消编辑：条目原样保留，输入框还原先前草稿"
                >
                  取消编辑
                </button>
                <button
                  type="button"
                  data-testid="composer-save-edit"
                  disabled={props.disabled}
                  onClick={submit}
                  className="h-8 shrink-0 rounded-full bg-accent px-3 text-xs text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-hover disabled:text-fg-subtle"
                  title="保存编辑（与 Enter 等效）：原地更新该条排队消息，不改变顺序"
                >
                  保存编辑
                </button>
                {stopButton}
              </>
            ) : props.streaming === true ? (
              <>
                {/* 票 05：忙且有输入 →「加入队列」主操作与「停止」并排（spec 用户故事 5）；
                      无输入或禁用（等待用户交互等）不提供入队，仅停止（用户故事 6 / 17）。 */}
                {value.trim() !== "" && !props.disabled && (
                  <button
                    type="button"
                    data-testid="composer-enqueue"
                    onClick={submit}
                    className="h-8 shrink-0 rounded-full bg-accent px-3 text-xs text-on-accent hover:bg-accent-hover"
                    title="加入队列（与 Enter 等效）：回复结束后自动逐条发出"
                  >
                    加入队列
                  </button>
                )}
                {stopButton}
              </>
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
    </ComposerRegion>
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
