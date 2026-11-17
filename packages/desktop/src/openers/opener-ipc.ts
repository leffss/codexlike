import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { ipcMain, type IpcMainInvokeEvent } from "electron";

import {
  createNodeProbeEnv,
  resolveOpeners,
  type OpenerProbeEnv,
  type ResolvedOpener,
} from "./opener-resolver";
import {
  isOpenerId,
  OPENER_IDS,
  OPENER_LABELS,
  resolveDefaultOpener,
  type OpenerId,
  type OpenerListResult,
  type OpenerOpenInput,
  type OpenerOpenResult,
  type OpenerSettingsStore,
} from "./opener-settings-store";
import { IPC } from "../shared/ipc";

/**
 * 工作区打开器 IPC（GLOSSARY「工作区打开器」）：
 * - list：候选（仅探测到的，资源管理器恒在）+ 生效默认（保存项卸载回退 explorer）；
 * - open：主按钮不带 id 用生效默认；点选带 id 以它打开并记为默认（打开
 *   失败不改默认）。IPC 边界不信任渲染进程：输入形状与目录存在性校验。
 * E2E 钩子 CODEXLIKE_TEST_OPENER_LOG（先例 task-ipc / file-ipc）：设置后
 * list 全量可用、open 只追加 JSON 行记录不启动真实程序，默认照常持久化。
 */

/** IPC 边界输入解析（纯函数，不信任渲染进程）：形状/枚举校验，中文异常抛回 */
export function parseOpenInput(input: unknown): OpenerOpenInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("打开工作区输入不合法");
  }
  const { workspacePath, openerId } = input as Record<string, unknown>;
  if (typeof workspacePath !== "string" || workspacePath === "") {
    throw new Error("工作区路径不合法");
  }
  if (openerId !== undefined && !isOpenerId(openerId)) {
    throw new Error("未知打开器");
  }
  return {
    workspacePath,
    ...(openerId === undefined ? {} : { openerId }),
  };
}

export function registerOpenerHandlers(options: {
  store: OpenerSettingsStore;
  /** 探测环境（生产默认 createNodeProbeEnv；测试注入） */
  probeEnv?: OpenerProbeEnv;
  /** 启动器（main.ts 装配处绑定 electron shell 与 child_process） */
  launch: (opener: ResolvedOpener, workspacePath: string) => Promise<void>;
  /** E2E 钩子（生产默认 CODEXLIKE_TEST_OPENER_LOG） */
  testLogPath?: string;
}): void {
  const { store, launch } = options;
  const probeEnv = options.probeEnv ?? createNodeProbeEnv();
  const testLogPath =
    options.testLogPath ?? process.env.CODEXLIKE_TEST_OPENER_LOG ?? null;

  /** 探测可用候选；E2E 钩子下全量可用（假 exe，open 只记录） */
  function available(): ResolvedOpener[] {
    if (testLogPath !== null) {
      return OPENER_IDS.map((id) => ({ id, exePath: `e2e:${id}` }));
    }
    return resolveOpeners(probeEnv);
  }

  ipcMain.handle(IPC.openers.list, async () => {
    const resolved = available();
    const ids = resolved.map((opener) => opener.id);
    const settings = await store.get();
    return {
      openers: resolved.map(({ id }) => ({ id, label: OPENER_LABELS[id] })),
      defaultId: resolveDefaultOpener(settings.defaultId, ids),
    } satisfies OpenerListResult;
  });

  ipcMain.handle(
    IPC.openers.open,
    async (_e: IpcMainInvokeEvent, input: unknown) => {
      const parsed = parseOpenInput(input);
      // 目录校验（不信任渲染进程）：须为本机存在的目录
      let isDirectory: boolean;
      try {
        isDirectory = statSync(parsed.workspacePath).isDirectory();
      } catch {
        isDirectory = false;
      }
      if (!isDirectory) {
        throw new Error("工作区目录不存在或不是目录");
      }
      const resolved = available();
      const settings = await store.get();
      const targetId: OpenerId =
        parsed.openerId ??
        resolveDefaultOpener(
          settings.defaultId,
          resolved.map((opener) => opener.id)
        );
      const opener = resolved.find((item) => item.id === targetId);
      if (opener === undefined) {
        throw new Error(`${OPENER_LABELS[targetId]} 未检测到，无法打开`);
      }
      if (testLogPath !== null) {
        // 目录自建（writeJsonFile 同款兜底）：e2e 可把日志指到尚不存在的目录
        mkdirSync(dirname(testLogPath), { recursive: true });
        appendFileSync(
          testLogPath,
          `${JSON.stringify({
            openerId: targetId,
            workspacePath: parsed.workspacePath,
          })}\n`,
          "utf8"
        );
      } else {
        await launch(opener, parsed.workspacePath);
      }
      // 点选即设置：打开成功后才落默认（失败试错不改设置）
      if (
        parsed.openerId !== undefined &&
        parsed.openerId !== settings.defaultId
      ) {
        await store.set({ defaultId: parsed.openerId });
      }
      return { defaultId: targetId } satisfies OpenerOpenResult;
    }
  );
}
