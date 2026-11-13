import { join } from "node:path";

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

/** 窗口部分现场；工作台目标与所在视图字段由后续票扩展进同一文件 */
export interface LaunchState {
  bounds: LaunchBounds;
  maximized: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 形状校验：bounds 四坐标须为有限数字、maximized 须为布尔（IPC/文件均不可信） */
export function isLaunchState(value: unknown): value is LaunchState {
  if (typeof value !== "object" || value === null) return false;
  const { bounds, maximized } = value as Record<string, unknown>;
  return (
    typeof bounds === "object" &&
    bounds !== null &&
    isFiniteNumber((bounds as Record<string, unknown>)["x"]) &&
    isFiniteNumber((bounds as Record<string, unknown>)["y"]) &&
    isFiniteNumber((bounds as Record<string, unknown>)["width"]) &&
    isFiniteNumber((bounds as Record<string, unknown>)["height"]) &&
    typeof maximized === "boolean"
  );
}

export interface LaunchStateStore {
  /** 已保存的启动现场；未配置（无文件/损坏/字段非法）返回 null，建窗走默认 */
  get(): Promise<LaunchState | null>;
  /** 保存现场（形状校验）并返回保存后的值 */
  set(state: LaunchState): Promise<LaunchState>;
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

  return {
    async get() {
      return loadFile();
    },

    async set(state) {
      if (!isLaunchState(state)) {
        throw new Error(
          "启动现场形状不合法（bounds 有限数字 + maximized 布尔）"
        );
      }
      writeJsonFile(filePath, state);
      return state;
    },
  };
}
