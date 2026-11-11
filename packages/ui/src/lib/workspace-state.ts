import type {
  InteractionRecord,
  InteractionResponse,
  ApprovalMode,
  ThinkingEffort,
} from "@codexlike/agent-core";

import {
  createQuestionDraft,
  updateQuestionDraft,
  type QuestionAction,
  type QuestionDraft,
} from "./interaction-draft";

export interface NewSessionDraft {
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

/** App 生命周期内的状态；不写磁盘，退出后未提交草稿自然丢弃。 */
export function createWorkspaceState() {
  const records = new Map<string, InteractionRecord>();
  const hidden = new Set<string>();
  const observedAt = new Map<string, number>();
  const drafts = new Map<string, QuestionDraft>();
  const composers = new Map<string, string>();
  const newDrafts = new Map<string | null, NewSessionDraft>();
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
    const id = key(record.request.sessionId, record.request.id);
    const previous = records.get(id);
    // 终态是墓碑，旧 pending 快照/请求事件永远不能把它复活。
    if (previous?.status !== undefined && previous.status !== "pending") return;
    records.set(id, record);
    observedAt.set(id, revision + 1);
    if (record.status !== "pending") drafts.delete(id);
    else if (record.request.kind === "questions" && !drafts.has(id))
      drafts.set(id, createQuestionDraft(record.request));
    notify();
  }
  return {
    activeSessionId: null as string | null,
    activeDraftProjectId: undefined as string | null | undefined,
    newDraft,
    editNewDraft(
      projectId: string | null,
      patch: Partial<Omit<NewSessionDraft, "requestId" | "projectId">>
    ) {
      Object.assign(newDraft(projectId), patch);
      notify();
    },
    completeNewDraft(projectId: string | null) {
      newDrafts.delete(projectId);
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
      composers.set(sessionId, text);
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
      drafts.set(id, updateQuestionDraft(record.request, draft, action));
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
