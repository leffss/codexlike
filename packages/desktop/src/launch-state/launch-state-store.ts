import { join } from "node:path";

import type { WorkbenchTarget } from "@codexlike/agent-core";

import { readJsonFile, writeJsonFile } from "../storage/json-file";

/**
 * 启动现场（GLOSSARY）：应用关闭时的界面现场，随状态变化持续保存、
 * 重开时整体恢复。本 store 是单文件 JSON 载体（launch-state.json），
 * 落统一数据目录（尊重 CODEXLIKE_HOME），建窗前消费。
 * 命名避开 WindowState——该词已被运行时最大化标志（shared/ipc.ts）占用。
 */

/** 正常态（非最大化）的窗口位置与尺寸；负坐标合法（多屏在主屏左侧/上方） */
export interface LaunchBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 顶层视图（票03）：工作区 / 设置 */
export type LaunchView = "workspace" | "settings";

/**
 * 启动现场：四字段各自可选（存在即必须合法）。窗口现场（票01/02）与
 * 目标/视图现场（票03）由不同写入方维护，部分现场合法——渲染层首启上报
 * 目标时文件尚无窗口字段；票01 时代的旧文件也没有目标/视图字段。
 */
export interface LaunchState {
  bounds?: LaunchBounds;
  maximized?: boolean;
  /** 退出前的工作台目标（GLOSSARY）：某会话，或新建草稿 + 项目关联 */
  workbenchTarget?: WorkbenchTarget;
  view?: LaunchView;
}

/** 局部更新：只覆盖给定字段，其余保留文件现值 */
export type LaunchStatePatch = Partial<LaunchState>;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 工作台目标形状校验（IPC 入参与文件内容均不可信） */
export function isWorkbenchTarget(value: unknown): value is WorkbenchTarget {
  if (typeof value !== "object" || value === null) return false;
  const { kind } = value as Record<string, unknown>;
  if (kind === "session") {
    return typeof (value as Record<string, unknown>)["sessionId"] === "string";
  }
  if (kind === "new") {
    const projectId = (value as Record<string, unknown>)["projectId"];
    return projectId === null || typeof projectId === "string";
  }
  return false;
}

export function isLaunchView(value: unknown): value is LaunchView {
  return value === "workspace" || value === "settings";
}

function isLaunchBounds(value: unknown): value is LaunchBounds {
  if (typeof value !== "object" || value === null) return false;
  const bounds = value as Record<string, unknown>;
  return (
    isFiniteNumber(bounds["x"]) &&
    isFiniteNumber(bounds["y"]) &&
    isFiniteNumber(bounds["width"]) &&
    isFiniteNumber(bounds["height"])
  );
}

/** 形状校验：字段存在即必须合法（部分现场合法，任何字段非法整体按未配置） */
export function isLaunchState(value: unknown): value is LaunchState {
  if (typeof value !== "object" || value === null) return false;
  const { bounds, maximized, workbenchTarget, view } = value as Record<
    string,
    unknown
  >;
  return (
    (bounds === undefined || isLaunchBounds(bounds)) &&
    (maximized === undefined || typeof maximized === "boolean") &&
    (workbenchTarget === undefined || isWorkbenchTarget(workbenchTarget)) &&
    (view === undefined || isLaunchView(view))
  );
}

export interface LaunchStateStore {
  /** 已保存的启动现场；未配置（无文件/损坏/字段非法）返回 null */
  get(): Promise<LaunchState | null>;
  /** 整体替换保存现场（形状校验）并返回保存后的值 */
  set(state: LaunchState): Promise<LaunchState>;
  /** 局部更新（合并写）：目标/视图上报不清掉其他写入方维护的字段 */
  patch(patch: LaunchStatePatch): Promise<LaunchState>;
}

const FILE_NAME = "launch-state.json";

/** 启动现场的本地存储（`~/.codexlike/launch-state.json`）；损坏文件按未配置处理 */
export function createLaunchStateStore(options: {
  dir: string;
}): LaunchStateStore {
  const filePath = join(options.dir, FILE_NAME);

  function loadFile(): LaunchState | null {
    const parsed = readJsonFile<unknown>(filePath, null, {
      corruptAsFallback: true,
    });
    return isLaunchState(parsed) ? parsed : null;
  }

  function assertValid(state: LaunchStatePatch): void {
    if (!isLaunchState(state)) {
      throw new Error(
        "启动现场形状不合法（bounds 有限数字、maximized 布尔、workbenchTarget 会话/新建草稿、view 二值枚举）"
      );
    }
  }

  return {
    async get() {
      return loadFile();
    },

    async set(state) {
      assertValid(state);
      writeJsonFile(filePath, state);
      return state;
    },

    async patch(patch) {
      assertValid(patch);
      // 无文件/损坏现场从空现场开始合并（损坏内容不复活）
      const merged = { ...(loadFile() ?? {}), ...patch };
      assertValid(merged);
      writeJsonFile(filePath, merged);
      return merged;
    },
  };
}
