import { useId, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ProviderProfile, ThinkingEffort } from "@codexlike/agent-core";
import {
  composerModelOptions,
  composerModelValue,
  modelOptionValue,
} from "../lib/model-options";
import { THINKING_EFFORT_OPTIONS } from "../lib/composer-options";
import { useStablePopover } from "../lib/use-stable-popover";

export interface ModelThinkingSelectProps {
  profiles: readonly ProviderProfile[];
  selectedProfileId: string;
  selectedModel?: string | null;
  thinkingEffort: ThinkingEffort | null;
  disabled?: boolean;
  onSelectModel: (profileId: string, model: string) => void;
  onSelectThinkingEffort: (effort: ThinkingEffort) => void;
  className?: string;
}

/** Profile 只浏览；模型与档位分别通过原业务回调即时保存。 */
export function ModelThinkingSelect(props: ModelThinkingSelectProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const { triggerRef, popoverRef, popoverStyle } = useStablePopover(open, {
    // 列表区最小可视高按「所有 Profile 中最长模型列表」动态预留（行高 ~36px）：
    // 少模型时弹层紧凑不虚高，存在长列表 Profile 时才预留到上限，切换仍一次
    // 锁定不跳（稳定与可用同时成立，见 use-stable-popover）。
    minScrollHeight: Math.min(
      220,
      Math.max(
        88,
        Math.max(...props.profiles.map((profile) => profile.models.length)) *
          32 +
          16
      )
    ),
  });
  const [browsedProfileId, setBrowsedProfileId] = useState(
    props.selectedProfileId
  );
  // roving tabindex：组内仅活跃项可 Tab；null = 未聚焦过组，取默认项（已选或首项）。
  const [activeModelValue, setActiveModelValue] = useState<string | null>(null);
  const [activeEffort, setActiveEffort] = useState<ThinkingEffort | null>(null);
  const selectedProfile = props.profiles.find(
    (profile) => profile.id === props.selectedProfileId
  );
  const browsedProfile =
    props.profiles.find((profile) => profile.id === browsedProfileId) ??
    props.profiles[0];
  const browsedModels = browsedProfile?.models ?? [];
  const defaultActiveModelValue = browsedModels.includes(
    props.selectedModel ?? ""
  )
    ? (props.selectedModel as string)
    : (browsedModels[0] ?? "");

  // 弹层内 roving 目标查询（事件时刻 DOM 直查，避免 effect 随内容重跑）
  function activeModelButton(): HTMLButtonElement | null {
    const buttons = Array.from(
      popoverRef.current?.querySelectorAll<HTMLButtonElement>(
        '[data-testid^="model-thinking-model-option-"]:not([disabled])'
      ) ?? []
    );
    return (
      buttons.find(
        (button) =>
          button.dataset.value ===
          modelOptionValue(
            browsedProfile?.id ?? "",
            activeModelValue ?? defaultActiveModelValue
          )
      ) ??
      buttons[0] ??
      null
    );
  }
  function activeEffortButton(): HTMLButtonElement | null {
    const buttons = popoverRef.current?.querySelectorAll<HTMLButtonElement>(
      '[data-testid^="model-thinking-effort-"]:not([disabled])'
    );
    if (!buttons?.length) return null;
    return (
      Array.from(buttons).find(
        (button) => button.dataset.effort === props.thinkingEffort
      ) ??
      buttons[0] ??
      null
    );
  }
  // 档位 Tab 出弹层：关闭后进入 trigger 在页面真实 Tab 序中的下一可聚焦控件
  //（portal 尚未卸载，先按文档序排除弹层子树再取 trigger 的后继）。
  function focusNextAfterTrigger() {
    const popover = popoverRef.current;
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => element.isConnected && !popover?.contains(element));
    const index = candidates.indexOf(triggerRef.current ?? document.body);
    (candidates[index + 1] ?? candidates[0])?.focus({ preventScroll: true });
  }
  // 空串与 null/undefined 同为「未显式选模型」（持久草稿允许只存 Profile）：
  // 显示回退 Profile 首项，不落成「已保存的模型不可用」失效态。
  const selectedModel = props.selectedModel || null;
  const model = selectedModel ?? selectedProfile?.models[0] ?? "";
  const value = composerModelValue(
    props.profiles,
    props.selectedProfileId,
    selectedModel
  );
  const selectedOption = composerModelOptions(
    props.profiles,
    props.selectedProfileId,
    selectedModel
  ).find((option) => option.value === value);
  const unavailable =
    props.selectedProfileId !== "" &&
    (!selectedProfile ||
      (selectedModel !== null &&
        !selectedProfile.models.includes(selectedModel)));
  const modelLabel = unavailable
    ? "已保存的模型不可用"
    : selectedProfile?.models.includes(model)
      ? model
      : (selectedOption?.label ?? "请选择模型");
  const identity = `${selectedProfile?.name ?? props.selectedProfileId} · ${model}`;
  const effortLabel =
    THINKING_EFFORT_OPTIONS.find(
      (option) => option.value === props.thinkingEffort
    )?.label.replace("思考：", "") ?? "不可用";

  useLayoutEffect(() => {
    if (!open) return;
    function outside(event: Event) {
      if (
        event.target instanceof Node &&
        !popoverRef.current?.contains(event.target) &&
        !triggerRef.current?.contains(event.target)
      )
        setOpen(false);
    }
    function close() {
      setOpen(false);
    }
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("blur", close);
    };
  }, [open, popoverRef, triggerRef]);

  useLayoutEffect(() => {
    if (props.disabled) setOpen(false);
  }, [props.disabled]);

  // 打开时进入弹层：已选模型（不在当前浏览列表则首模型），空列表退到提供商下拉。
  // deps 只挂 open：打开期间浏览/保存变化不重抢焦点（StrictMode 重挂只重复聚焦同元素）。
  useLayoutEffect(() => {
    if (!open) return;
    const models = popoverRef.current?.querySelector<HTMLButtonElement>(
      '[data-testid^="model-thinking-model-option-"][aria-pressed="true"]'
    );
    (
      models ??
      popoverRef.current?.querySelector<HTMLButtonElement>(
        '[data-testid^="model-thinking-model-option-"]'
      ) ??
      popoverRef.current?.querySelector<HTMLSelectElement>(
        '[data-testid="model-thinking-provider"]'
      )
    )?.focus({ preventScroll: true });
    // 长列表中选中项可能远离顶部：定位几何在 place 的 setState flush 后才应用，
    // 此刻弹层还是 static 流内元素，同步 scrollIntoView 滚的是文档而非列表——
    // 推到下一帧（geometry 已应用、布局完成）再滚入可视区（nearest 只滚必要量）。
    requestAnimationFrame(() => {
      models?.scrollIntoView({ block: "nearest" });
    });
  }, [open, popoverRef]);

  return (
    <>
      <button
        ref={triggerRef}
        disabled={props.disabled}
        type="button"
        data-testid="model-thinking-select"
        data-model-value={value}
        data-thinking-effort={props.thinkingEffort ?? ""}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={
          unavailable
            ? `${modelLabel}：${identity}，请重新选择模型`
            : (selectedOption?.title ?? modelLabel)
        }
        className={`inline-flex min-w-0 items-center gap-1 rounded-md border border-line bg-surface-muted px-2.5 py-1 text-xs text-fg-muted ${props.className ?? ""}`}
        onClick={() => {
          setBrowsedProfileId(props.selectedProfileId);
          setOpen(!open);
        }}
      >
        <span className="min-w-0 truncate">{modelLabel}</span>
        <span className="shrink-0"> · {effortLabel}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            id={id}
            onKeyDown={(event) => {
              if (
                event.key === "Escape" &&
                !event.nativeEvent.isComposing &&
                !(event.target instanceof HTMLSelectElement)
              ) {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                triggerRef.current?.focus({ preventScroll: true });
              }
            }}
            role="dialog"
            aria-label="模型与思考"
            data-testid="model-thinking-popover"
            style={popoverStyle}
            className="z-50 flex w-[220px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-lg border border-line bg-surface text-xs text-fg shadow-lg"
          >
            <label className="flex items-center gap-2 px-2.5 py-1.5">
              <span className="shrink-0 text-fg-subtle">提供商</span>
              <select
                disabled={props.profiles.length === 0}
                data-testid="model-thinking-provider"
                value={browsedProfile?.id ?? ""}
                onChange={(event) => setBrowsedProfileId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.key !== "Tab")
                    return;
                  // Shift+Tab 关闭回 trigger；Tab 进模型（空列表退档位，档位也不可用则放行）
                  event.preventDefault();
                  if (event.shiftKey) {
                    setOpen(false);
                    triggerRef.current?.focus({ preventScroll: true });
                    return;
                  }
                  (
                    activeModelButton() ??
                    activeEffortButton() ??
                    triggerRef.current
                  )?.focus({ preventScroll: true });
                }}
                className="min-w-0 flex-1 truncate rounded border border-line bg-surface-muted px-1.5 py-1"
              >
                {props.profiles.length === 0 && (
                  <option value="">未配置模型</option>
                )}
                {props.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
            <div
              role="group"
              aria-label="模型"
              data-testid="model-thinking-models"
              data-stable-popover-scroll=""
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Tab") {
                  // 档位可用 → 接管为弹层内流转；档位全禁用（thinkingEffort=null，
                  // 当前仅无任务可达，而那时统一控件整体禁用打不开弹层——此为
                  // 防御分支）不拦截，交给浏览器默认 Tab 离开弹层。
                  const effort = activeEffortButton();
                  if (!effort) return;
                  event.preventDefault();
                  if (event.shiftKey) {
                    (
                      popoverRef.current?.querySelector<HTMLSelectElement>(
                        '[data-testid="model-thinking-provider"]'
                      ) ?? effort
                    ).focus({ preventScroll: true });
                  } else {
                    effort.focus({ preventScroll: true });
                  }
                  return;
                }
                const buttons = Array.from(
                  popoverRef.current?.querySelectorAll<HTMLButtonElement>(
                    '[data-testid^="model-thinking-model-option-"]:not([disabled])'
                  ) ?? []
                );
                const current = buttons.indexOf(
                  event.target as HTMLButtonElement
                );
                let next: number | null = null;
                if (event.key === "ArrowDown")
                  next = Math.min(current + 1, buttons.length - 1);
                else if (event.key === "ArrowUp")
                  next = Math.max(current - 1, 0);
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = buttons.length - 1;
                if (next === null) return;
                event.preventDefault();
                buttons[next]?.focus();
                // focus 的隐式滚动在 overflow 容器内不可靠：显式滚入。
                buttons[next]?.scrollIntoView({ block: "nearest" });
              }}
              className="min-h-0 flex-1 overflow-y-auto border-y border-line p-1"
            >
              {unavailable && (
                <p
                  role="status"
                  className="p-2 text-warn-fg [overflow-wrap:anywhere]"
                >
                  已保存的模型不可用：{identity}，请重新选择模型
                </p>
              )}
              {!browsedProfile?.models.length && (
                <p className="p-2 text-fg-subtle">
                  {browsedProfile ? "此提供商暂无模型" : "未配置模型"}
                </p>
              )}
              {browsedModels.map((item) => {
                const optionValue = modelOptionValue(
                  browsedProfile?.id ?? "",
                  item
                );
                return (
                  <button
                    key={optionValue}
                    type="button"
                    tabIndex={
                      (activeModelValue ?? defaultActiveModelValue) === item
                        ? 0
                        : -1
                    }
                    onFocus={() => setActiveModelValue(item)}
                    data-testid={`model-thinking-model-option-${optionValue}`}
                    data-value={optionValue}
                    aria-pressed={optionValue === value}
                    className={`block w-full rounded px-2 py-1.5 text-left hover:bg-hover ${
                      optionValue === value ? "bg-hover text-fg" : ""
                    }`}
                    onClick={() =>
                      props.onSelectModel(browsedProfile!.id, item)
                    }
                  >
                    {item}
                  </button>
                );
              })}
            </div>
            <div
              role="group"
              aria-label="思考档位"
              data-testid="model-thinking-efforts"
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Tab") {
                  // 档位 Tab 出弹层：关闭后进入 trigger 在页面真实 Tab 序中的下一可聚焦控件
                  //（portal 尚未卸载，先按文档序排除弹层子树再取 trigger 的后继）。
                  event.preventDefault();
                  if (event.shiftKey) {
                    (
                      activeModelButton() ??
                      popoverRef.current?.querySelector<HTMLSelectElement>(
                        '[data-testid="model-thinking-provider"]'
                      )
                    )?.focus({ preventScroll: true });
                    return;
                  }
                  setOpen(false);
                  focusNextAfterTrigger();
                  return;
                }
                if (
                  event.key !== "ArrowLeft" &&
                  event.key !== "ArrowRight" &&
                  event.key !== "Home" &&
                  event.key !== "End"
                )
                  return;
                event.preventDefault();
                const buttons = Array.from(
                  popoverRef.current?.querySelectorAll<HTMLButtonElement>(
                    '[data-testid^="model-thinking-effort-"]:not([disabled])'
                  ) ?? []
                );
                const current = buttons.indexOf(
                  event.target as HTMLButtonElement
                );
                const next =
                  event.key === "ArrowLeft"
                    ? Math.max(current - 1, 0)
                    : event.key === "ArrowRight"
                      ? Math.min(current + 1, buttons.length - 1)
                      : event.key === "Home"
                        ? 0
                        : buttons.length - 1;
                buttons[next]?.focus();
              }}
              className="flex gap-1 px-2 py-1.5"
            >
              {THINKING_EFFORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  disabled={props.thinkingEffort === null}
                  type="button"
                  tabIndex={
                    (activeEffort ?? props.thinkingEffort) === option.value
                      ? 0
                      : -1
                  }
                  onFocus={() => setActiveEffort(option.value)}
                  data-testid={`model-thinking-effort-${option.value}`}
                  data-effort={option.value}
                  aria-pressed={props.thinkingEffort === option.value}
                  title={option.title}
                  className={`min-w-0 flex-1 rounded px-1.5 py-1 hover:bg-hover ${
                    props.thinkingEffort === option.value
                      ? "bg-hover text-fg"
                      : ""
                  }`}
                  onClick={() => {
                    setOpen(false);
                    triggerRef.current?.focus({ preventScroll: true });
                    props.onSelectThinkingEffort(option.value);
                  }}
                >
                  {option.label.replace("思考：", "")}
                </button>
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
