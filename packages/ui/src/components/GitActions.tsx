import { useState } from "react";

import { taskBranchName } from "@codexlike/agent-core";

/**
 * git 提交动作组（右栏「改动」tab 底部，prototype/panels-redesign 变体 A
 * 折叠；原 ChangesPanel footer 的行为与 testid 原样转正）：
 * 一键创建分支（`taskBranchName` 生成 `类型/<slug>`）+ 模型生成提交消息（可编辑）+ 提交。
 * 提交成功后经 onCommitted 通知宿主刷新 git 状态。
 */
export function GitActions(props: {
  taskId: string;
  taskTitle: string;
  /** 生成提交消息所用 provider profile（模型请求走真实 IPC） */
  selectedProfileId: string;
  /** git 工作区不可用时禁用 */
  disabled?: boolean;
  onCommitted: () => void;
}) {
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchFeedback, setBranchFeedback] = useState<string | null>(null);
  const [commitDraft, setCommitDraft] = useState("");
  const [commitBusy, setCommitBusy] = useState<"generate" | "commit" | null>(
    null
  );
  const [commitFeedback, setCommitFeedback] = useState<string | null>(null);

  async function createBranch() {
    setBranchBusy(true);
    setBranchFeedback(null);
    try {
      const result = await window.codexlike.git.createBranch(props.taskId);
      setBranchFeedback(
        result.created
          ? `已创建并切换到分支 ${result.branch}`
          : `分支已存在，已切换到 ${result.branch}`
      );
      props.onCommitted();
    } catch (error) {
      setBranchFeedback(
        `创建分支失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setBranchBusy(false);
    }
  }

  /** 模型按任务内容生成提交消息草稿（一次不发工具的请求；可编辑、失败可手写） */
  async function generateMessage() {
    setCommitBusy("generate");
    setCommitFeedback(null);
    try {
      const draft = await window.codexlike.git.generateCommitMessage(
        props.taskId,
        props.selectedProfileId
      );
      setCommitDraft(draft);
    } catch (error) {
      setCommitFeedback(
        `${error instanceof Error ? error.message : String(error)}（可直接手动填写后提交）`
      );
    } finally {
      setCommitBusy(null);
    }
  }

  async function commit() {
    if (commitDraft.trim() === "") {
      setCommitFeedback("提交消息不能为空");
      return;
    }
    setCommitBusy("commit");
    setCommitFeedback(null);
    try {
      const result = await window.codexlike.git.commit(
        props.taskId,
        commitDraft.trim()
      );
      if (result.committed) {
        setCommitFeedback(`已提交（${result.commitHash?.slice(0, 7) ?? ""}）`);
        setCommitDraft("");
        props.onCommitted();
      } else {
        setCommitFeedback(result.reason ?? "没有可提交的变更");
      }
    } catch (error) {
      setCommitFeedback(
        `提交失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setCommitBusy(null);
    }
  }

  const disabled = props.disabled === true;
  return (
    <div className="space-y-2 px-3 py-2">
      <button
        type="button"
        data-testid="changes-create-branch"
        onClick={() => void createBranch()}
        disabled={branchBusy || disabled}
        className="w-full rounded border border-line px-3 py-1.5 text-sm text-fg hover:border-accent hover:text-accent disabled:opacity-50"
        title={`创建并切换到分支 ${taskBranchName(props.taskTitle)}`}
      >
        {branchBusy ? "创建中…" : `创建分支 ${taskBranchName(props.taskTitle)}`}
      </button>
      {branchFeedback !== null && (
        <p data-testid="changes-branch-feedback" className="text-xs text-ok-fg">
          {branchFeedback}
        </p>
      )}

      <textarea
        data-testid="changes-commit-message"
        value={commitDraft}
        onChange={(event) => setCommitDraft(event.target.value)}
        placeholder="提交消息（可由模型生成，可编辑）"
        rows={2}
        className="w-full resize-none rounded border border-line bg-code-bg p-2 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
      />
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="changes-generate-message"
          onClick={() => void generateMessage()}
          disabled={commitBusy !== null || disabled}
          className="flex-1 rounded border border-line px-3 py-1.5 text-sm text-fg hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {commitBusy === "generate" ? "生成中…" : "生成提交消息"}
        </button>
        <button
          type="button"
          data-testid="changes-commit"
          onClick={() => void commit()}
          disabled={commitBusy !== null || disabled}
          className="flex-1 rounded border border-ok-fg/40 bg-ok-bg px-3 py-1.5 text-sm text-ok-fg hover:border-ok-fg disabled:opacity-50"
        >
          {commitBusy === "commit" ? "提交中…" : "提交全部变更"}
        </button>
      </div>
      {commitFeedback !== null && (
        <p
          data-testid="changes-commit-feedback"
          className="text-xs text-fg-muted"
        >
          {commitFeedback}
        </p>
      )}
    </div>
  );
}
