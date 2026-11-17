import { join } from "node:path";

import { readJsonFile, writeJsonFile } from "../storage/json-file";

/**
 * 工作区打开器设置（GLOSSARY「工作区打开器」）：标题栏分裂按钮的默认
 * 打开器一项。点选下拉项即用该项打开并记为默认（行为即设置，不设设置页
 * 入口）；资源管理器恒可用，是保存项失效（卸载）时的回退兜底。
 */

/** 工作区打开器 id 枚举（顺序即下拉菜单顺序；explorer 恒在兜底） */
export const OPENER_IDS = [
  "explorer",
  "vscode",
  "pycharm",
  "intellij",
  "webstorm",
] as const;

export type OpenerId = (typeof OPENER_IDS)[number];

export function isOpenerId(value: unknown): value is OpenerId {
  return (
    typeof value === "string" &&
    (OPENER_IDS as readonly string[]).includes(value)
  );
}

/** 打开器中文标签（下拉菜单展示） */
export const OPENER_LABELS: Record<OpenerId, string> = {
  explorer: "资源管理器",
  vscode: "VS Code",
  pycharm: "PyCharm",
  intellij: "IntelliJ IDEA",
  webstorm: "WebStorm",
};

/** 工作区打开器设置（get 返回完整形状） */
export interface OpenerSettings {
  /** 主按钮默认打开器；未配置/非法回退 explorer */
  defaultId: OpenerId;
}

/**
 * 生效默认折算（纯函数）：保存的默认未出现在可用列表（如已卸载）时回退
 * explorer——不改写文件，重装后保存项自行恢复生效。
 */
export function resolveDefaultOpener(
  saved: OpenerId,
  available: readonly OpenerId[]
): OpenerId {
  return (available as readonly string[]).includes(saved) ? saved : "explorer";
}

export interface OpenerSettingsStore {
  /** 已保存的设置；未配置（无文件）时 defaultId 为 explorer */
  get(): Promise<OpenerSettings>;
  /** 保存设置（id 枚举校验）并返回保存后的值 */
  set(settings: OpenerSettings): Promise<OpenerSettings>;
}

/* ---- IPC 契约形状（electron-free，shared/ipc.ts 与 preload 引用） ---- */

/** 下拉菜单候选项（渲染进程只拿 id 与标签，exe 路径不出主进程） */
export interface OpenerView {
  id: OpenerId;
  label: string;
}

export interface OpenerListResult {
  openers: OpenerView[];
  defaultId: OpenerId;
}

export interface OpenerOpenInput {
  workspacePath: string;
  /** 点选下拉项时携带：以它打开并记为默认 */
  openerId?: OpenerId;
}

export interface OpenerOpenResult {
  /** 本次打开所用程序（即生效默认） */
  defaultId: OpenerId;
}

const FILE_NAME = "opener-settings.json";

/** 工作区打开器设置的本地存储（`~/.codexlike/opener-settings.json`）；损坏文件按默认值处理 */
export function createOpenerSettingsStore(options: {
  dir: string;
}): OpenerSettingsStore {
  const filePath = join(options.dir, FILE_NAME);

  function loadFile(): OpenerSettings {
    const parsed = readJsonFile<Partial<OpenerSettings>>(
      filePath,
      {},
      {
        corruptAsFallback: true,
      }
    );
    return {
      defaultId: isOpenerId(parsed.defaultId) ? parsed.defaultId : "explorer",
    };
  }

  return {
    async get() {
      return loadFile();
    },

    async set(settings) {
      if (!isOpenerId(settings.defaultId)) {
        throw new Error("默认打开器必须是已知打开器之一");
      }
      const next: OpenerSettings = { defaultId: settings.defaultId };
      writeJsonFile(filePath, next);
      return next;
    },
  };
}
