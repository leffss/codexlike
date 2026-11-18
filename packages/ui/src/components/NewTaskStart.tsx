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
  type ProjectRecord,
  type ProviderProfile,
  type SkillDescriptor,
  type SlashCommandDef,
} from "@codexlike/agent-core";
import type { NewTaskDraft } from "../lib/workspace-state";
import {
  applyMentionSelection,
  applySkillSelection,
  computeMenu,
  handleMenuKey,
  type ComposerMenuState,
} from "../lib/composer-menu";
import {
  APPROVAL_MODE_OPTIONS,
  THINKING_EFFORT_OPTIONS,
} from "../lib/composer-options";
import {
  composerModelOptions,
  composerModelValue,
  parseModelOptionValue,
} from "../lib/model-options";
import { WorkspaceModeSelector } from "./WorkspaceModeSelector";
import { ComposerSelect } from "./ComposerSelect";
import { ComposerMenuList } from "./ComposerMenuList";
import { ApprovalModeIcon, ArrowUpIcon, BrainIcon } from "./ComposerIcons";

/**
 * 新建任务居中起点页（ADR 0026 变体 A「决策台」，票 01 骨架转正）：
 * 草稿态主列整体替换为居中起点式布局——800px 居中列、垂直居中、纯起点
 * 留白；标题行右侧为项目归属选择器（票 02：可选某项目或不选，切换即
 * 切换入口，由上层走 startCreateTask 同语义恢复对应入口的持久草稿）；
 * 工作区单独成卡（项目任务：路径 + 本地/Worktree 切换；独立任务：专用
 * 目录文案 + 选择已有目录/回退）；审批/模型/思考一级呈现（技能不入一级：
 * 输入框 `$` 直调，placeholder 承载发现性）；专属输入卡壳（更大输入区、
 * 圆形上箭头发送按钮、空输入禁用）。
 *
 * 域语义红线（spec「实现决策」）：本组件只动呈现层——草稿字段经
 * onEditDraft 写回既有 NewTaskDraft（requestId/projectId 不可改），
 * 归属切换只发 onSwitchProject 回调（持久草稿的加载/重置由上层承担），
 * 首条发送才创建任务、失败保留输入由 WorkspacePage 的 sendFirst 承担；
 * 独立任务（projectId === null）无 Worktree 选项。无 Profile 时整体
 * 替换为配置引导卡（spec 用户故事 10）。
 */
export interface NewTaskStartProps {
  draft: NewTaskDraft;
  projects: readonly ProjectRecord[];
  profiles: readonly ProviderProfile[];
  /** @引用 菜单候选（工作区文件） */
  workspaceFiles: readonly string[];
  /** 技能候选（$ 菜单）；打开技能菜单时经 onOpenSkills 重新发现 */
  skills?: readonly SkillDescriptor[];
  onOpenSkills: () => void;
  /** 草稿字段写回（text/workspacePath/workspaceMode/审批/模型/思考等） */
  onEditDraft: (
    patch: Partial<Omit<NewTaskDraft, "requestId" | "projectId">>
  ) => void;
  /** 切换任务归属 = 切换入口（上层走 startCreateTask 同语义恢复对应入口持久草稿，并重置独立任务已选目录） */
  onSwitchProject: (projectId: string | null) => void;
  /** 「选择已有目录」（原生目录对话框），仅独立任务 */
  onSelectWorkspace: () => void;
  /** 审批模式切换（full-access 的风险确认弹层由 WorkspacePage 统一拦截） */
  onSelectApprovalMode: (mode: ApprovalMode) => void;
  /** 提交输入（斜杠命令/首条消息由上层 resolveComposerSubmission 分发） */
  onSend: (text: string) => void;
  onOpenSettings: () => void;
}

/** 归属选择器中「不选项目（独立任务）」的值（ComposerSelect 值域为 string） */
const STANDALONE_PROJECT_VALUE = "standalone";

export function NewTaskStart(props: NewTaskStartProps) {
  const { draft, projects } = props;
  const project =
    draft.projectId !== null
      ? (projects.find((item) => item.id === draft.projectId) ?? null)
      : null;
  const isStandalone = draft.projectId === null;

  // 无 Provider Profile：起点卡整体替换为配置引导卡（spec 用户故事 10），
  // 不渲染残缺表单
  if (props.profiles.length === 0) {
    return (
      <div
        data-testid="new-task-start"
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
      >
        <div className="mx-auto flex min-h-full w-full max-w-md flex-1 items-center justify-center px-6 py-12">
          <div
            data-testid="draft-empty-start"
            className="w-full rounded-lg border border-line bg-surface p-8 text-center shadow-sm"
          >
            <div className="text-xl font-semibold tracking-wide text-fg">
              CodexLike
            </div>
            <p className="mt-3 text-sm text-fg-muted">
              还没有配置模型接入——新建任务需要一个可用的 Provider Profile。
            </p>
            <button
              type="button"
              data-testid="draft-goto-settings"
              onClick={props.onOpenSettings}
              className="mt-5 rounded bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              前往设置配置接入
            </button>
          </div>
        </div>
      </div>
    );
  }

  const workspacePath = draft.workspacePath ?? project?.workspacePath ?? null;

  return (
    <div
      data-testid="new-task-start"
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto flex min-h-full w-full max-w-[800px] flex-1 items-center justify-center px-6 py-12">
        <div className="w-full">
          {/* 标题行：左「新建任务」，右侧项目归属选择器（票 02：切换归属 =
              切换入口——选择即回调 onSwitchProject，由上层恢复对应入口的
              持久草稿；busy（首条发送中）不可切） */}
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-lg font-semibold text-fg">新建任务</h1>
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-xs text-fg-subtle">项目</span>
              <ComposerSelect
                testId="draft-project-select"
                label="项目"
                value={draft.projectId ?? STANDALONE_PROJECT_VALUE}
                disabled={draft.busy}
                options={[
                  {
                    value: STANDALONE_PROJECT_VALUE,
                    label: "不选项目（独立任务）",
                    title: "不选项目，作为独立任务创建",
                  },
                  ...projects.map((item) => ({
                    value: item.id,
                    label: item.name,
                    title: item.workspacePath,
                  })),
                ]}
                onSelect={(value) =>
                  props.onSwitchProject(
                    value === STANDALONE_PROJECT_VALUE ? null : value
                  )
                }
                className="max-w-[320px]"
              />
            </div>
          </div>

          {/* 工作区卡（最重决策项，单独成卡） */}
          <div
            data-testid="draft-workspace-info"
            className="mb-3 rounded-lg border border-line bg-surface p-3"
          >
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              <span aria-hidden="true">📁</span> 工作区
              {!isStandalone &&
                (draft.workspaceMode ?? "local") === "worktree" && (
                  <span className="text-fg-subtle">
                    来源目录，发送后使用隔离工作区
                  </span>
                )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span
                data-testid="workspace-path"
                title={workspacePath ?? undefined}
                className="min-w-0 break-all font-mono text-xs text-fg"
              >
                {workspacePath ?? "应用专用持久目录（发送第一条消息后分配）"}
              </span>
              {!isStandalone && (
                <WorkspaceModeSelector
                  mode={draft.workspaceMode ?? "local"}
                  busy={draft.busy}
                  onModeChange={(workspaceMode) => {
                    if (!draft.busy)
                      props.onEditDraft({ workspaceMode, error: null });
                  }}
                />
              )}
              {/* 独立任务：专用持久目录为默认，可选择已有目录并回退（无 Worktree） */}
              {isStandalone && !draft.workspacePath && (
                <button
                  type="button"
                  data-testid="draft-select-workspace"
                  disabled={draft.busy}
                  onClick={props.onSelectWorkspace}
                  className="shrink-0 rounded border border-line px-2 py-1 text-xs text-accent hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  选择已有目录
                </button>
              )}
              {isStandalone && draft.workspacePath && (
                <button
                  type="button"
                  data-testid="draft-managed-workspace"
                  disabled={draft.busy}
                  onClick={() =>
                    props.onEditDraft({ workspacePath: undefined })
                  }
                  className="shrink-0 rounded border border-line px-2 py-1 text-xs text-accent hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  使用专用目录
                </button>
              )}
            </div>
          </div>

          {/* 决策行：审批/模型/思考一级呈现（与正式任务 composer 同款选择器；
              技能不入一级——输入框 `$` 直调，placeholder 承载发现性） */}
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <ComposerSelect
              testId="approval-mode-select"
              label="审批模式"
              value={draft.approvalMode}
              disabled={draft.busy}
              options={APPROVAL_MODE_OPTIONS}
              onSelect={props.onSelectApprovalMode}
              renderIcon={(mode) => (
                <ApprovalModeIcon
                  mode={mode}
                  className={`h-3 w-3 ${mode === "full-access" ? "text-warn-fg" : ""}`}
                />
              )}
            />
            <ComposerSelect
              testId="profile-select"
              label="模型"
              value={composerModelValue(
                props.profiles,
                draft.providerProfileId,
                draft.model
              )}
              disabled={draft.busy}
              options={composerModelOptions(
                props.profiles,
                draft.providerProfileId,
                draft.model
              )}
              onSelect={(value) => {
                const parsed = parseModelOptionValue(value);
                if (parsed)
                  props.onEditDraft({
                    providerProfileId: parsed.profileId,
                    model: parsed.model,
                  });
              }}
            />
            <ComposerSelect
              testId="thinking-effort-select"
              label="思考档位"
              value={draft.thinkingEffort}
              disabled={draft.busy}
              options={THINKING_EFFORT_OPTIONS}
              onSelect={(thinkingEffort) =>
                props.onEditDraft({ thinkingEffort })
              }
              renderIcon={() => <BrainIcon className="h-3 w-3" />}
            />
          </div>

          {/* 专属输入卡壳：更大输入区 + 圆形上箭头发送按钮（composer 同款）；
              `/`·`@`·`$` 菜单复用 composer 系子件与 lib */}
          <StartComposer {...props} />
        </div>
      </div>
    </div>
  );
}

/** 新建起点页专属输入卡（票 01）：菜单交互与 MessageComposer 同构（lib 共享），行为差异只有三处——textarea 更高、placeholder 承载 `$ 技能` 发现性、无队列/停止等任务态控件。 */
function StartComposer(props: NewTaskStartProps) {
  const { draft } = props;
  const value = draft.text;
  const [menu, setMenu] = useState<ComposerMenuState | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** Esc 关闭菜单的签名（value + 光标）：draft 未变化前不再自动弹出 */
  const dismissedRef = useRef<string | null>(null);
  const skillMenuOpenRef = useRef(false);
  const canSend = value.trim() !== "" && !draft.busy;

  const { workspaceFiles, skills, onOpenSkills } = props;
  const syncMenu = useCallback(
    (text: string, caretIndex: number) => {
      const signature = `${text.length}:${caretIndex}:${text}`;
      if (dismissedRef.current === signature) return;
      const parsed = parseComposerDraft(text, { caretIndex });
      const openingSkills =
        parsed.menu === "skills" && !skillMenuOpenRef.current;
      skillMenuOpenRef.current = parsed.menu === "skills";
      setMenu(
        computeMenu(parsed, {
          files: workspaceFiles,
          skills,
        })
      );
      if (openingSkills) onOpenSkills?.();
    },
    [workspaceFiles, skills, onOpenSkills]
  );

  // 异步候选（技能预览）到达时重算；Esc 关闭后不因刷新而重开。

  useEffect(() => {
    const caret = textareaRef.current?.selectionStart ?? value.length;
    syncMenu(value, caret);
  }, [workspaceFiles, skills]);

  function commitText(next: string, caretIndex: number) {
    props.onEditDraft({ text: next });
    dismissedRef.current = null;
    syncMenu(next, caretIndex);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caretIndex, caretIndex);
    });
  }

  function submit() {
    // 空白检查不改原文；提交解析（斜杠命令/首条消息）由上层统一分发
    if (value.trim() === "" || draft.busy) return;
    props.onSend(value);
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
        // 无参命令选中即提交（与正式 composer 同构），清空输入防重复
        props.onEditDraft({ text: "" });
        setMenu(null);
        dismissedRef.current = null;
        if (!draft.busy) props.onSend(`/${command.name}`);
      } else {
        commitText(`/${command.name} `, `/${command.name} `.length);
      }
    }
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
    <form
      data-testid="new-task-composer"
      className="rounded-lg border border-line bg-surface p-3 shadow-sm"
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
          readOnly={draft.busy}
          data-testid="composer-input"
          value={value}
          onChange={(event) => {
            props.onEditDraft({ text: event.target.value });
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
          placeholder="描述这个任务要做什么…（/ 命令 · @ 文件 · $ 技能）"
          rows={5}
          className="min-h-[110px] w-full resize-y bg-transparent px-1 text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
        />
      </div>
      {draft.error && (
        <p
          data-testid="draft-error"
          role="alert"
          className="mt-2 break-words text-xs text-danger-fg"
        >
          {draft.error}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-fg-subtle">发送第一条消息后创建任务</span>
        <button
          type="submit"
          data-testid="composer-send"
          disabled={!canSend}
          title="发送（Enter 发送，Shift+Enter 换行）"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-hover disabled:text-fg-subtle"
        >
          <ArrowUpIcon className="h-4 w-4" />
        </button>
      </div>
    </form>
  );
}
