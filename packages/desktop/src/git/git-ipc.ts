import {
  codexlikeBranchName,
  createGitService,
  createLanguageModelFromProfile,
  generateCommitMessage,
  type ProviderProfile,
  type SessionManager,
  type SessionRecord,
} from "@codexlike/agent-core/node";

import { ipcMain, type IpcMainInvokeEvent } from "electron";

import type { ProfileStore } from "../profiles/profile-store";
import { IPC } from "../shared/ipc";

/**
 * 改动面板 + git 集成的 IPC 指令（工单 05）。
 * git 逻辑在 agent-core 的 git 服务（真实 git repo 测试覆盖），
 * 这里只做：会话 → 工作区的接线、输入校验、错误中文化。
 */
export function registerGitHandlers(options: {
  manager: SessionManager;
  profiles: ProfileStore;
}): void {
  const { manager, profiles } = options;

  /** IPC 边界不信任渲染进程：sessionId 必须对应存在的会话 */
  function findSession(sessionId: unknown): SessionRecord {
    if (typeof sessionId !== "string") {
      throw new Error("git：sessionId 必须是字符串");
    }
    const record = manager
      .list()
      .find((candidate: SessionRecord) => candidate.id === sessionId);
    if (record === undefined) {
      throw new Error("会话不存在或已损坏");
    }
    return record;
  }

  ipcMain.handle(
    IPC.git.status,
    async (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      const record = findSession(sessionId);
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
      sessionId: unknown,
      path: unknown,
      oldPath: unknown
    ) => {
      const record = findSession(sessionId);
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
    async (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      const record = findSession(sessionId);
      // 分支名由会话名生成（codexlike/<会话名>，sanitize 在 agent-core 纯函数）
      try {
        return await createGitService(record.workspacePath).createTaskBranch(
          codexlikeBranchName(record.title)
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
    async (_e: IpcMainInvokeEvent, sessionId: unknown, profileId: unknown) => {
      const record = findSession(sessionId);
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
        // 按会话内容 + 变更文件列表生成（一次不发工具的请求）
        return await generateCommitMessage({
          model,
          messages: manager.messages(record.id),
          changedFiles: status.files.map((file) => file.path),
        });
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
    async (_e: IpcMainInvokeEvent, sessionId: unknown, message: unknown) => {
      const record = findSession(sessionId);
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
