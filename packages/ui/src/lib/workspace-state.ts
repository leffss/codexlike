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
    thinkingEffort: "auto",
    approvalMode: "ask",
  };
  const taskTarget = (sessionId: string) => ({
    kind: "session" as const,
    sessionId,
  });
  const records = new Map<string, InteractionRecord>();
  const hidden = new Set<string>();
  const observedAt = new Map<string, number>();
  const drafts = new Map<string, QuestionDraft>();
  const composers = new Map<string, string>();
  const newDrafts = new Map<string | null, NewTaskDraft>();
  function newDraft(projectId: string | null, defaultProfile = "") {
    let draft = newDrafts.get(projectId);
    if (!draft) {
      draft = {
        requestId: crypto.randomUUID(),
        projectId,
        text: "",
        providerProfileId: defaultProfile,
        thinkingEffort: "auto",
        approvalMode: "ask",
        busy: false,
        error: null,
      };
      newDrafts.set(projectId, draft);
    }
    if (!draft.providerProfileId && defaultProfile)
      draft.providerProfileId = defaultProfile;
    return draft;
  }
  const submissions = new Map<string, SubmissionState>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const key = (sessionId: string, requestId: string) =>
    JSON.stringify([sessionId, requestId]);
  function notify() {
    revision += 1;
    for (const listener of listeners) listener();
  }
  function observe(record: InteractionRecord) {
    if (removedTasks.has(record.request.sessionId)) return;
    const id = key(record.request.sessionId, record.request.id);
    const previous = records.get(id);
    // 终态是墓碑，旧 pending 快照/请求事件永远不能把它复活。
    if (previous?.status !== undefined && previous.status !== "pending") return;
    records.set(id, record);
    observedAt.set(id, revision + 1);
    if (record.status === "resolved") {
      drafts.delete(id);
      persisted.patch(taskTarget(record.request.sessionId), (value) => {
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
    async loadTask(sessionId: string) {
      if (loaded.has(sessionId)) return;
      const entry = await persisted.load(taskTarget(sessionId));
      if (removedTasks.has(sessionId)) return;
      if (entry && !loaded.has(sessionId)) {
        if (!composers.has(sessionId))
          composers.set(sessionId, entry.value.text);
        if (!preferences.has(sessionId))
          preferences.set(sessionId, entry.value.preferences);
        if (!positions.has(sessionId))
          positions.set(sessionId, entry.value.readingPosition);
        for (const [requestId, draft] of Object.entries(
          entry.value.questionDrafts
        ))
          drafts.set(key(sessionId, requestId), draft);
      }
      loaded.add(sessionId);
      notify();
    },
    async loadNewDraft(projectId: string | null, defaultProfile = "") {
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
          busy: false,
          error: null,
        });
      newDraft(projectId, defaultProfile);
      notify();
    },
    preferences: (sessionId: string) =>
      preferences.get(sessionId) ?? defaultPreferences,
    setPreferences(sessionId: string, patch: Partial<TaskPreferences>) {
      if (removedTasks.has(sessionId)) return;
      preferences.set(sessionId, {
        ...(preferences.get(sessionId) ?? defaultPreferences),
        ...patch,
      });
      persisted.patch(taskTarget(sessionId), (value) => ({
        ...value,
        preferences: { ...value.preferences, ...patch },
      }));
      notify();
    },
    readingPosition: (sessionId: string) => positions.get(sessionId) ?? null,
    setReadingPosition(sessionId: string, position: ReadingPosition) {
      if (removedTasks.has(sessionId)) return;
      positions.set(sessionId, position);
      persisted.patch(taskTarget(sessionId), (value) => ({
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
            thinkingEffort: snapshot.thinkingEffort,
            approvalMode: snapshot.approvalMode,
          },
        }));
      }
      notify();
    },
    /** 仅清除宿主返回的明确归属集合，不比较工作区路径。 */
    removeProject(projectId: string, sessionIds: string[]) {
      removedProjects.add(projectId);
      persisted.remove({ kind: "new", projectId });
      newDrafts.delete(projectId);
      const removed = new Set(sessionIds);
      for (const sessionId of removed) {
        removedTasks.add(sessionId);
        persisted.remove(taskTarget(sessionId));
        composers.delete(sessionId);
        preferences.delete(sessionId);
        positions.delete(sessionId);
        loaded.delete(sessionId);
      }
      for (const [id, record] of records) {
        if (!removed.has(record.request.sessionId)) continue;
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
    reconcile(sessionId: string, snapshot: InteractionRecord[], since: number) {
      const visible = new Set(
        snapshot.map((record) => key(sessionId, record.request.id))
      );
      for (const [id, record] of records) {
        if (
          record.request.sessionId === sessionId &&
          record.status !== "pending" &&
          !visible.has(id) &&
          (observedAt.get(id) ?? 0) <= since
        )
          hidden.add(id);
      }
      for (const record of snapshot) {
        if (record.request.sessionId !== sessionId) continue;
        hidden.delete(key(sessionId, record.request.id));
        observe(record);
      }
      notify();
    },
    submission: (sessionId: string, requestId: string) =>
      submissions.get(key(sessionId, requestId)) ?? idleSubmission,
    async submit(
      sessionId: string,
      requestId: string,
      response: InteractionResponse,
      send: (
        sessionId: string,
        requestId: string,
        response: InteractionResponse
      ) => Promise<boolean>
    ) {
      const id = key(sessionId, requestId);
      const record = records.get(id);
      if (record?.status !== "pending" || submissions.get(id)?.busy) return;
      submissions.set(id, { busy: true, error: null });
      notify();
      try {
        const accepted = await send(sessionId, requestId, response);
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
    composer: (sessionId: string) => composers.get(sessionId) ?? "",
    setComposer(sessionId: string, text: string) {
      if (removedTasks.has(sessionId)) return;
      composers.set(sessionId, text);
      persisted.patch(taskTarget(sessionId), (value) => ({
        ...value,
        text,
      }));
      notify();
    },
    draft: (sessionId: string, requestId: string) =>
      drafts.get(key(sessionId, requestId)),
    edit(sessionId: string, requestId: string, action: QuestionAction) {
      const id = key(sessionId, requestId);
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
      persisted.patch(taskTarget(sessionId), (value) => ({
        ...value,
        questionDrafts: { ...value.questionDrafts, [requestId]: next },
      }));
      notify();
    },
    records(sessionId: string) {
      return [...records.values()].filter(
        (record) =>
          record.request.sessionId === sessionId &&
          !hidden.has(key(sessionId, record.request.id))
      );
    },
    pending(sessionId: string) {
      return [...records.values()]
        .filter(
          (record) =>
            record.request.sessionId === sessionId &&
            record.status === "pending"
        )
        .sort((a, b) => a.request.createdAt.localeCompare(b.request.createdAt));
    },
  };
}

export type WorkspaceState = ReturnType<typeof createWorkspaceState>;
