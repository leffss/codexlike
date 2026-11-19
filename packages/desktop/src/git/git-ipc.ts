import {
  taskBranchName,
  createGitService,
  createLanguageModelFromProfile,
  generateCommitMessage,
  settleTaskUsage,
  type ProviderProfile,
  type TaskManager,
  type TaskRecord,
} from "@codexlike/agent-core/node";

import { ipcMain, type IpcMainInvokeEvent } from "electron";

import type { ProfileStore } from "../profiles/profile-store";
import { IPC } from "../shared/ipc";

/**
 * 改动面板 + git 集成的 IPC 指令（工单 05）。
 * git 逻辑在 agent-core 的 git 服务（真实 git repo 测试覆盖），
 * 这里只做：任务 → 工作区的接线、输入校验、错误中文化。
 */
export function registerGitHandlers(options: {
  manager: TaskManager;
  profiles: ProfileStore;
}): void {
  const { manager, profiles } = options;

  /** IPC 边界不信任渲染进程：taskId 必须对应存在的任务 */
  function findTask(taskId: unknown): TaskRecord {
    if (typeof taskId !== "string") {
      throw new Error("git：taskId 必须是字符串");
    }
    const record = manager
      .list()
      .find((candidate: TaskRecord) => candidate.id === taskId);
    if (record === undefined) {
      throw new Error("任务不存在或已损坏");
    }
    return record;
  }

  ipcMain.handle(
    IPC.git.status,
    async (_e: IpcMainInvokeEvent, taskId: unknown) => {
      const record = findTask(taskId);
      try {
        return await createGitService(record.workspacePath).status();
      } catch (error) {
        throw new Error(
          `读取 git 状态失败：${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
  );

  ipcMain.handle(
    IPC.git.diff,
    async (
      _e: IpcMainInvokeEvent,
      taskId: unknown,
      path: unknown,
      oldPath: unknown
    ) => {
      const record = findTask(taskId);
      if (typeof path !== "string" || path === "") {
        throw new Error("git diff：文件路径不合法");
      }
      if (oldPath !== undefined && typeof oldPath !== "string") {
        throw new Error("git diff：原路径不合法");
      }
      try {
        return await createGitService(record.workspacePath).diffFile(
          path,
          oldPath
        );
      } catch (error) {
        throw new Error(
          `读取文件改动失败：${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
  );

  ipcMain.handle(
    IPC.git.createBranch,
    async (_e: IpcMainInvokeEvent, taskId: unknown) => {
      const record = findTask(taskId);
      // 分支名由任务名生成（类型/<slug>，中文剥除+长度上限，sanitize 在 agent-core 纯函数）
      try {
        return await createGitService(record.workspacePath).createTaskBranch(
          taskBranchName(record.title)
        );
      } catch (error) {
        throw new Error(
          `创建分支失败：${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
  );

  ipcMain.handle(
    IPC.git.commitMessage,
    async (_e: IpcMainInvokeEvent, taskId: unknown, profileId: unknown) => {
      const record = findTask(taskId);
      if (typeof profileId !== "string" || profileId === "") {
        throw new Error("生成提交消息需要先选择模型（Provider Profile）");
      }
      const profile = (await profiles.list()).find(
        (candidate: ProviderProfile) => candidate.id === profileId
      );
      if (profile === undefined) {
        throw new Error("所选 Provider Profile 不存在，请重新选择模型");
      }
      const model = createLanguageModelFromProfile(profile);
      const status = await createGitService(record.workspacePath).status();
      if (!status.isGitRepo) {
        throw new Error("当前工作区不是 git 仓库");
      }
      try {
        // 按任务内容 + 变更文件列表生成（一次不发工具的请求）
        const { message } = await generateCommitMessage({
          model,
          messages: manager.messages(record.id),
          changedFiles: status.files.map((file) => file.path),
          // 任务用量（GLOSSARY「任务用量」，ADR 0029）：commit 消息生成是任务域
          // 模型调用，真实 usage 入主任务列（空白失败也照报；入账失败不拖垮生成）
          onUsage: (usage) =>
            void settleTaskUsage(
              usage,
              (delta) => manager.addUsage(record.id, delta),
              "main"
            ),
        });
        return message;
      } catch (error) {
        throw new Error(
          `生成提交消息失败：${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
  );

  ipcMain.handle(
    IPC.git.commit,
    async (_e: IpcMainInvokeEvent, taskId: unknown, message: unknown) => {
      const record = findTask(taskId);
      if (typeof message !== "string" || message.trim() === "") {
        throw new Error("提交消息不能为空");
      }
      try {
        return await createGitService(record.workspacePath).commitAll(message);
      } catch (error) {
        throw new Error(
          `提交失败：${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
  );
}
