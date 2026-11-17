import type {
  InteractionRecord,
  InteractionResponse,
  ApprovalMode,
  ThinkingEffort,
  TaskPreferences,
  ReadingPosition,
} from "@codexlike/agent-core";

import {
  createQuestionDraft,
  updateQuestionDraft,
  type QuestionAction,
  type QuestionDraft,
} from "./interaction-draft";

import {
  createPersistentWorkbench,
  type WorkbenchPort,
} from "./persistent-workbench";

export interface NewTaskDraft {
  requestId: string;
  projectId: string | null;
  text: string;
  workspacePath?: string;
  workspaceMode?: "local" | "worktree";
  providerProfileId: string;
  /** 首条消息所用具体模型（票 02 二元组）；空串 = 未显式选（回退第一项） */
  model: string;
  thinkingEffort: ThinkingEffort;
  approvalMode: ApprovalMode;
  busy: boolean;
  error: string | null;
}

export interface SubmissionState {
  busy: boolean;
  error: string | null;
}
const idleSubmission: SubmissionState = { busy: false, error: null };

/** 运行交互只在内存；草稿与下次发送设置经宿主持久保存。 */
export function createWorkspaceState(port?: WorkbenchPort) {
  const persisted = createPersistentWorkbench(port, notify);
  const preferences = new Map<string, TaskPreferences>();
  const positions = new Map<string, ReadingPosition | null>();
  const loaded = new Set<string>();
  const removedTasks = new Set<string>();
  const removedProjects = new Set<string>();
  const defaultPreferences: TaskPreferences = {
    providerProfileId: "",
    // 旧持久化数据无 model 字段（票 02 前）：undefined 等价未显式选，
    // 发送时由主进程/agent-core 回退 Profile 列表第一项
    model: "",
    thinkingEffort: "auto",
    approvalMode: "ask",
  };
  const taskTarget = (taskId: string) => ({
    kind: "task" as const,
    taskId,
  });
  const records = new Map<string, InteractionRecord>();
  const hidden = new Set<string>();
  const observedAt = new Map<string, number>();
  const drafts = new Map<string, QuestionDraft>();
  const composers = new Map<string, string>();
  const newDrafts = new Map<string | null, NewTaskDraft>();
  function newDraft(
    projectId: string | null,
    defaultProfile = "",
    defaultModel = ""
  ) {
    let draft = newDrafts.get(projectId);
    if (!draft) {
      draft = {
        requestId: crypto.randomUUID(),
        projectId,
        text: "",
        providerProfileId: defaultProfile,
        // 新建任务默认 Profile 列表第一项（票 02：不选模型也能直接开工）
        model: defaultModel,
        thinkingEffort: "auto",
        approvalMode: "ask",
        busy: false,
        error: null,
      };
      newDrafts.set(projectId, draft);
    }
    if (!draft.providerProfileId && defaultProfile) {
      draft.providerProfileId = defaultProfile;
      // 旧持久化草稿无 model：随默认 Profile 补第一项
      if (!draft.model) draft.model = defaultModel;
    }
    return draft;
  }
  const submissions = new Map<string, SubmissionState>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const key = (taskId: string, requestId: string) =>
    JSON.stringify([taskId, requestId]);
  function notify() {
    revision += 1;
    for (const listener of listeners) listener();
  }
  function observe(record: InteractionRecord) {
    if (removedTasks.has(record.request.taskId)) return;
    const id = key(record.request.taskId, record.request.id);
    const previous = records.get(id);
    // 终态是墓碑，旧 pending 快照/请求事件永远不能把它复活。
    if (previous?.status !== undefined && previous.status !== "pending") return;
    records.set(id, record);
    observedAt.set(id, revision + 1);
    if (record.status === "resolved") {
      drafts.delete(id);
      persisted.patch(taskTarget(record.request.taskId), (value) => {
        const questionDrafts = { ...value.questionDrafts };
        delete questionDrafts[record.request.id];
        return { ...value, questionDrafts };
      });
    } else if (
      record.status === "pending" &&
      record.request.kind === "questions" &&
      !drafts.has(id)
    )
      drafts.set(id, createQuestionDraft(record.request));
    notify();
  }
  return {
    flush: persisted.flush,
    persistenceError: persisted.error,
    async loadTask(taskId: string) {
      if (loaded.has(taskId)) return;
      const entry = await persisted.load(taskTarget(taskId));
      if (removedTasks.has(taskId)) return;
      if (entry && !loaded.has(taskId)) {
        if (!composers.has(taskId)) composers.set(taskId, entry.value.text);
        if (!preferences.has(taskId))
          preferences.set(taskId, entry.value.preferences);
        if (!positions.has(taskId))
          positions.set(taskId, entry.value.readingPosition);
        for (const [requestId, draft] of Object.entries(
          entry.value.questionDrafts
        ))
          drafts.set(key(taskId, requestId), draft);
      }
      loaded.add(taskId);
      notify();
    },
    async loadNewDraft(
      projectId: string | null,
      defaultProfile = "",
      defaultModel = ""
    ) {
      const entry = await persisted.load({ kind: "new", projectId });
      if (projectId !== null && removedProjects.has(projectId)) return;
      if (entry && !newDrafts.has(projectId))
        newDrafts.set(projectId, {
          requestId: entry.value.requestId,
          projectId,
          text: entry.value.text,
          workspacePath: entry.value.workspacePath,
          workspaceMode: entry.value.workspaceMode,
          ...entry.value.preferences,
          // 旧持久化草稿（票 02 前）无 model：归一空串 = 未显式选（回退第一项）
          model: entry.value.preferences.model ?? "",
          busy: false,
          error: null,
        });
      newDraft(projectId, defaultProfile, defaultModel);
      notify();
    },
    preferences: (taskId: string) =>
      preferences.get(taskId) ?? defaultPreferences,
    setPreferences(taskId: string, patch: Partial<TaskPreferences>) {
      if (removedTasks.has(taskId)) return;
      preferences.set(taskId, {
        ...(preferences.get(taskId) ?? defaultPreferences),
        ...patch,
      });
      persisted.patch(taskTarget(taskId), (value) => ({
        ...value,
        preferences: { ...value.preferences, ...patch },
      }));
      notify();
    },
    readingPosition: (taskId: string) => positions.get(taskId) ?? null,
    setReadingPosition(taskId: string, position: ReadingPosition) {
      if (removedTasks.has(taskId)) return;
      positions.set(taskId, position);
      persisted.patch(taskTarget(taskId), (value) => ({
        ...value,
        readingPosition: position,
      }));
    },
    activeTaskId: null as string | null,
    activeDraftProjectId: undefined as string | null | undefined,
    newDraft,
    editNewDraft(
      projectId: string | null,
      patch: Partial<Omit<NewTaskDraft, "requestId" | "projectId">>
    ) {
      if (projectId !== null && removedProjects.has(projectId)) return;
      const draft = newDraft(projectId);
      Object.assign(draft, patch);
      if (Object.keys(patch).some((key) => key !== "busy" && key !== "error")) {
        const snapshot = structuredClone(draft);
        persisted.patch({ kind: "new", projectId }, (value) => ({
          ...value,
          requestId: snapshot.requestId,
          text: snapshot.text,
          workspacePath: snapshot.workspacePath,
          workspaceMode: snapshot.workspaceMode,
          preferences: {
            providerProfileId: snapshot.providerProfileId,
            model: snapshot.model,
            thinkingEffort: snapshot.thinkingEffort,
            approvalMode: snapshot.approvalMode,
          },
        }));
      }
      notify();
    },
    /** 仅清除宿主返回的明确归属集合，不比较工作区路径。 */
    removeProject(projectId: string, taskIds: string[]) {
      removedProjects.add(projectId);
      persisted.remove({ kind: "new", projectId });
      newDrafts.delete(projectId);
      const removed = new Set(taskIds);
      for (const taskId of removed) {
        removedTasks.add(taskId);
        persisted.remove(taskTarget(taskId));
        composers.delete(taskId);
        preferences.delete(taskId);
        positions.delete(taskId);
        loaded.delete(taskId);
      }
      for (const [id, record] of records) {
        if (!removed.has(record.request.taskId)) continue;
        records.delete(id);
        drafts.delete(id);
        submissions.delete(id);
        hidden.delete(id);
        observedAt.delete(id);
      }
      notify();
    },
    async completeNewDraft(projectId: string | null) {
      persisted.forget({ kind: "new", projectId });
      const entry = await persisted.load({ kind: "new", projectId });
      if (projectId !== null && removedProjects.has(projectId)) return;
      newDrafts.delete(projectId);
      if (entry)
        newDrafts.set(projectId, {
          requestId: entry.value.requestId,
          projectId,
          text: entry.value.text,
          workspacePath: entry.value.workspacePath,
          workspaceMode: entry.value.workspaceMode,
          ...entry.value.preferences,
          model: entry.value.preferences.model ?? "",
          busy: false,
          error: null,
        });
      notify();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => revision,
    observe,
    /** 权威历史隐藏已压缩记录，但墓碑保留；查询期间新事件与pending草稿不丢。 */
    reconcile(taskId: string, snapshot: InteractionRecord[], since: number) {
      const visible = new Set(
        snapshot.map((record) => key(taskId, record.request.id))
      );
      for (const [id, record] of records) {
        if (
          record.request.taskId === taskId &&
          record.status !== "pending" &&
          !visible.has(id) &&
          (observedAt.get(id) ?? 0) <= since
        )
          hidden.add(id);
      }
      for (const record of snapshot) {
        if (record.request.taskId !== taskId) continue;
        hidden.delete(key(taskId, record.request.id));
        observe(record);
      }
      notify();
    },
    submission: (taskId: string, requestId: string) =>
      submissions.get(key(taskId, requestId)) ?? idleSubmission,
    async submit(
      taskId: string,
      requestId: string,
      response: InteractionResponse,
      send: (
        taskId: string,
        requestId: string,
        response: InteractionResponse
      ) => Promise<boolean>
    ) {
      const id = key(taskId, requestId);
      const record = records.get(id);
      if (record?.status !== "pending" || submissions.get(id)?.busy) return;
      submissions.set(id, { busy: true, error: null });
      notify();
      try {
        const accepted = await send(taskId, requestId, response);
        if (records.get(id)?.status !== "pending") return;
        if (accepted) {
          observe({
            ...record,
            status: "resolved",
            response,
            resolvedAt: new Date().toISOString(),
          });
        } else {
          const error = "该交互请求已失效，不能重复回答";
          observe({ ...record, status: "cancelled", cancelReason: error });
          submissions.set(id, { busy: false, error });
        }
      } catch (error) {
        if (records.get(id)?.status === "pending")
          submissions.set(id, {
            busy: false,
            error: `提交失败：${error instanceof Error ? error.message : String(error)}`,
          });
      } finally {
        submissions.set(id, {
          busy: false,
          error: submissions.get(id)?.error ?? null,
        });
        notify();
      }
    },
    composer: (taskId: string) => composers.get(taskId) ?? "",
    setComposer(taskId: string, text: string) {
      if (removedTasks.has(taskId)) return;
      composers.set(taskId, text);
      persisted.patch(taskTarget(taskId), (value) => ({
        ...value,
        text,
      }));
      notify();
    },
    draft: (taskId: string, requestId: string) =>
      drafts.get(key(taskId, requestId)),
    edit(taskId: string, requestId: string, action: QuestionAction) {
      const id = key(taskId, requestId);
      const record = records.get(id);
      const draft = drafts.get(id);
      if (
        record?.status !== "pending" ||
        record.request.kind !== "questions" ||
        !draft ||
        submissions.get(id)?.busy
      )
        return;
      const next = updateQuestionDraft(record.request, draft, action);
      drafts.set(id, next);
      persisted.patch(taskTarget(taskId), (value) => ({
        ...value,
        questionDrafts: { ...value.questionDrafts, [requestId]: next },
      }));
      notify();
    },
    records(taskId: string) {
      return [...records.values()].filter(
        (record) =>
          record.request.taskId === taskId &&
          !hidden.has(key(taskId, record.request.id))
      );
    },
    pending(taskId: string) {
      return [...records.values()]
        .filter(
          (record) =>
            record.request.taskId === taskId && record.status === "pending"
        )
        .sort((a, b) => a.request.createdAt.localeCompare(b.request.createdAt));
    },
  };
}

export type WorkspaceState = ReturnType<typeof createWorkspaceState>;
