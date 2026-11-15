import { useReducer } from "react";

/**
 * 折叠开合的渲染层内存态（ADR 0011：按段/轮 key 记忆，不进数据层）。
 *
 * 开合值按 key（轮 id / 段 id）保存在渲染进程内存：
 * - 用户手动开合后按键记忆，滚动、切换任务、组件重挂载（MessageStream
 *   按任务 key 重挂载）都不丢；
 * - 没有手动操作过的键返回 undefined，由调用方回退到默认开合
 *   （运行中/中断/失败强制展开、正常完成收起、轮完成自动收起一次
 *   都是「默认值随事实变化」，记忆值只覆盖、不参与推导）。
 */

/** key → 用户手动设置的开合（true=展开 / false=收起） */
const remembered = new Map<string, boolean>();

/** 读取记忆值；未手动操作过返回 undefined */
export function rememberedOpen(key: string): boolean | undefined {
  return remembered.get(key);
}

/** 记录一次手动开合 */
export function setRememberedOpen(key: string, open: boolean): void {
  remembered.set(key, open);
}

/**
 * 悬浮元素位置记忆（工作计划徽章，ADR 0016）：key → 用户拖设的视口坐标。
 * 与开合同属渲染层内存态（ADR 0011）：任务切换、组件重挂载不丢；跨应用
 * 重启不记忆——默认位置随窗口重新锚定（记忆的是视口坐标，重启后窗口
 * 尺寸可能不同，保留旧值反而错位）。
 */
const rememberedPositions = new Map<string, { x: number; y: number }>();

/** 读取位置记忆；未拖设过返回 undefined */
export function rememberedPosition(
  key: string
): { x: number; y: number } | undefined {
  return rememberedPositions.get(key);
}

/** 记录一次拖设收官的位置（徽章左上角视口坐标） */
export function setRememberedPosition(
  key: string,
  pos: { x: number; y: number }
): void {
  rememberedPositions.set(key, pos);
}

/** 清除位置记忆（右键「回到默认位置」） */
export function clearRememberedPosition(key: string): void {
  rememberedPositions.delete(key);
}

/**
 * 折叠开合 hook：open 是「记忆值 ?? 默认值」的派生态。
 * toggle/setOpen 写记忆并触发重渲染；默认值变化（如运行中→完成）对
 * 未手动操作过的键立即生效（完成即收起，用户故事 17），
 * 已手动操作过的键不被覆盖（autoCollapse 边沿规则）。
 *
 * setOpen 供受控 <details> 的 onToggle 同步用：原生开合改的是 DOM 态，
 * 渲染态不重算就找不到用户这次操作（toggle 只能取反，写不了事件事实）。
 */
export function useCollapseState(
  key: string,
  defaultOpen: boolean
): { open: boolean; toggle: () => void; setOpen: (open: boolean) => void } {
  const [, render] = useReducer((tick: number) => tick + 1, 0);
  const open = remembered.get(key) ?? defaultOpen;
  const setOpen = (next: boolean) => {
    setRememberedOpen(key, next);
    render();
  };
  const toggle = () => {
    setOpen(!open);
  };
  return { open, toggle, setOpen };
}
