import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
} from "electron";

import { IPC } from "../shared/ipc";

/**
 * 渲染层文件导出的 IPC 指令（复制旁的「导出 Markdown」按钮）：
 * 位置与文件名由原生保存对话框交给用户决定，主进程按所选路径写盘；
 * 取消不写、不报错。渲染进程永不传绝对路径——落点只来自对话框。
 */
export function registerFileHandlers(options: {
  getWindow: () => BrowserWindow | null;
}): void {
  const { getWindow } = options;

  ipcMain.handle(
    IPC.files.saveText,
    async (
      _e: IpcMainInvokeEvent,
      input: unknown
    ): Promise<{ saved: boolean; path?: string }> => {
      if (typeof input !== "object" || input === null) {
        throw new Error("saveText：参数必须是对象");
      }
      const { defaultFileName, content } = input as {
        defaultFileName?: unknown;
        content?: unknown;
      };
      if (
        typeof defaultFileName !== "string" ||
        defaultFileName.trim() === ""
      ) {
        throw new Error("saveText：默认文件名不能为空");
      }
      if (typeof content !== "string") {
        throw new Error("saveText：内容必须是字符串");
      }

      // E2E 钩子（先例：tasks.selectWorkspace 的 CODEXLIKE_TEST_WORKSPACE）：
      // 自动化无法操作原生保存对话框，固定写入该目录（不存在则创建）。
      const pinnedDir = process.env.CODEXLIKE_TEST_EXPORT_DIR;
      if (pinnedDir !== undefined && pinnedDir !== "") {
        await mkdir(pinnedDir, { recursive: true });
        const target = path.join(pinnedDir, defaultFileName);
        await writeFile(target, content, "utf8");
        return { saved: true, path: target };
      }

      const dialogOptions = {
        defaultPath: defaultFileName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      };
      const win = getWindow();
      const result = win
        ? await dialog.showSaveDialog(win, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      if (result.canceled || result.filePath === undefined) {
        return { saved: false };
      }
      // 无后缀时补 .md；用户手输其他后缀则按原样尊重
      const target =
        path.extname(result.filePath) === ""
          ? `${result.filePath}.md`
          : result.filePath;
      await writeFile(target, content, "utf8");
      return { saved: true, path: target };
    }
  );
}
