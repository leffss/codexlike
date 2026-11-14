import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import {
  APPROVAL_MODES,
  parseThinkingEffort,
  workbenchKey,
  type TaskManager,
  type WorkbenchTarget,
  type WorkbenchEntry,
  type WorkbenchValue,
} from "@codexlike/agent-core/node";
import type { ProfileStore } from "../profiles/profile-store";
import { IPC } from "../shared/ipc";

/** 单独的持久工作现场边界：读写不启动执行，不把问答文本当成授权。 */
export function registerWorkbenchHandlers(
  manager: TaskManager,
  profiles: ProfileStore
) {
  function targetOf(input: unknown): WorkbenchTarget {
    const target = input as WorkbenchTarget;
    if (
      target?.kind === "task" &&
      typeof target.taskId === "string" &&
      manager.list().some((s) => s.id === target.taskId)
    )
      return target;
    if (
      target?.kind === "new" &&
      (target.projectId === null ||
        manager.projects().some((p) => p.id === target.projectId))
    )
      return target;
    throw new Error("持久工作现场的项目或任务不存在");
  }
  async function read(target: WorkbenchTarget): Promise<WorkbenchEntry> {
    const key = workbenchKey(target);
    const saved = manager.readWorkbench(key);
    if (saved) return saved;
    const profile = (await profiles.list())[0];
    targetOf(target);
    // 读默认值期间可能已有写入，不能用迟到的默认状态覆盖它。
    const latest = manager.readWorkbench(key);
    if (latest) return latest;
    const task =
      target.kind === "task"
        ? manager.list().find((s) => s.id === target.taskId)
        : null;
    const entry: WorkbenchEntry = {
      revision: 0,
      value: {
        text: "",
        requestId: randomUUID(),
        questionDrafts: {},
        readingPosition: null,
        preferences: {
          providerProfileId: task?.providerProfileId ?? profile?.id ?? "",
          thinkingEffort: "auto",
          approvalMode: task?.approvalMode ?? "ask",
        },
      },
    };
    manager.writeWorkbench(key, entry);
    return entry;
  }
  ipcMain.handle(IPC.workbench.read, (_e, target: unknown) =>
    read(targetOf(target))
  );
  ipcMain.handle(IPC.workbench.write, (_e, target: unknown, input: unknown) => {
    const checked = targetOf(target);
    const entry = input as WorkbenchEntry;
    if (
      !Number.isSafeInteger(entry?.revision) ||
      entry.revision < 1 ||
      typeof entry.value?.text !== "string" ||
      typeof entry.value.requestId !== "string" ||
      typeof entry.value.preferences?.providerProfileId !== "string" ||
      !APPROVAL_MODES.includes(entry.value.preferences.approvalMode)
    )
      throw new Error("持久工作现场内容不合法");
    parseThinkingEffort(entry.value.preferences.thinkingEffort);
    const position = entry.value.readingPosition;
    if (
      position !== null &&
      (!position ||
        !Number.isFinite(position.scrollTop) ||
        position.scrollTop < 0 ||
        (position.anchorId !== undefined &&
          typeof position.anchorId !== "string") ||
        (position.offset !== undefined && !Number.isFinite(position.offset)) ||
        (position.atBottom !== undefined &&
          typeof position.atBottom !== "boolean"))
    )
      throw new Error("阅读位置不合法");
    if (
      entry.value.workspacePath !== undefined &&
      typeof entry.value.workspacePath !== "string"
    )
      throw new Error("工作区路径不合法");
    if (
      entry.value.workspaceMode !== undefined &&
      !["local", "worktree"].includes(entry.value.workspaceMode)
    )
      throw new Error("工作区模式不合法");
    const questions = entry.value.questionDrafts;
    if (!questions || typeof questions !== "object" || Array.isArray(questions))
      throw new Error("问答草稿不合法");
    const questionDrafts: WorkbenchValue["questionDrafts"] = {};
    const history =
      checked.kind === "task" ? manager.interactions(checked.taskId) : [];
    for (const [id, draft] of Object.entries(questions)) {
      const item = history.find((item) => item.request.id === id);
      if (
        item?.request.kind !== "questions" ||
        !Number.isSafeInteger(draft?.index) ||
        draft.index < 0 ||
        draft.index >= item.request.questions.length ||
        !draft.answers ||
        typeof draft.answers !== "object"
      )
        throw new Error("问答草稿与任务请求不匹配");
      const answers: typeof draft.answers = {};
      for (const question of item.request.questions) {
        const answer = draft.answers[question.id];
        if (
          !answer ||
          typeof answer.text !== "string" ||
          typeof answer.skipped !== "boolean" ||
          !Array.isArray(answer.selectedOptionIds) ||
          answer.selectedOptionIds.some(
            (id) => !question.options.some((option) => option.id === id)
          )
        )
          throw new Error("问答草稿内容不合法");
        answers[question.id] = {
          text: answer.text,
          skipped: answer.skipped,
          selectedOptionIds: [...answer.selectedOptionIds],
        };
      }
      questionDrafts[id] = { index: draft.index, answers };
    }
    const value: WorkbenchValue = {
      text: entry.value.text,
      requestId: entry.value.requestId,
      preferences: {
        providerProfileId: entry.value.preferences.providerProfileId,
        thinkingEffort: entry.value.preferences.thinkingEffort,
        approvalMode: entry.value.preferences.approvalMode,
      },
      readingPosition:
        position === null
          ? null
          : {
              scrollTop: position.scrollTop,
              ...(position.anchorId === undefined
                ? {}
                : { anchorId: position.anchorId }),
              ...(position.offset === undefined
                ? {}
                : { offset: position.offset }),
              ...(position.atBottom === undefined
                ? {}
                : { atBottom: position.atBottom }),
            },
      questionDrafts,
      ...(entry.value.workspacePath === undefined
        ? {}
        : { workspacePath: entry.value.workspacePath }),
      ...(entry.value.workspaceMode === undefined
        ? {}
        : { workspaceMode: entry.value.workspaceMode }),
    };
    const previous = manager.readWorkbench(workbenchKey(checked));
    if (
      checked.kind === "new" &&
      previous &&
      previous.value.requestId !== value.requestId
    )
      return { accepted: false, entry: previous };
    const accepted = manager.writeWorkbench(workbenchKey(checked), {
      revision: entry.revision,
      value,
    });
    if (accepted && checked.kind === "task")
      manager.setApprovalMode(checked.taskId, value.preferences.approvalMode);
    return { accepted, entry: manager.readWorkbench(workbenchKey(checked))! };
  });
  return {
    read,
    started(
      projectId: string | null,
      requestId: string,
      taskId: string,
      preferences: WorkbenchValue["preferences"],
      defaultProfileId: string,
      acceptedText?: string
    ) {
      // 首次发送可能已完成且记录刚被用户移除；不能初始化悬挂工作现场。
      if (!manager.list().some((task) => task.id === taskId)) return;
      const target: WorkbenchTarget = { kind: "new", projectId };
      const key = workbenchKey(target);
      const taskKey = workbenchKey({ kind: "task", taskId });
      if (!manager.readWorkbench(taskKey))
        manager.writeWorkbench(taskKey, {
          revision: 0,
          value: {
            text: "",
            requestId: randomUUID(),
            questionDrafts: {},
            readingPosition: null,
            preferences,
          },
        });
      // 使用启动前已解析的默认模型，不在首条消息接受后再解密配置。
      // 仅消费对应意图；草稿写入没有 await，读取后同步替换。
      const latest = manager.readWorkbench(key);
      if (latest?.value.requestId === requestId)
        manager.writeWorkbench(key, {
          revision: latest.revision + 1,
          // 补偿时草稿可能已编辑；只轮换意图，不能把未执行的新文本当成旧任务清空。
          value:
            acceptedText !== undefined && latest.value.text !== acceptedText
              ? { ...latest.value, requestId: randomUUID() }
              : {
                  text: "",
                  requestId: randomUUID(),
                  questionDrafts: {},
                  readingPosition: null,
                  preferences: {
                    providerProfileId: defaultProfileId,
                    thinkingEffort: "auto",
                    approvalMode: "ask",
                  },
                },
        });
    },
  };
}
