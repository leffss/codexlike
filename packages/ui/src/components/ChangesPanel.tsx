import { lazy, Suspense, useCallback, useEffect, useState } from 'react';

import type { GitChangeKind, GitFileChange, GitStatus } from '@codexlike/agent-core';
import { codexlikeBranchName } from '@codexlike/agent-core';

import { languageForPath } from '../lib/diff-language';

const MonacoDiff = lazy(() => import('./MonacoDiff'));

/** 变更类型 → 中文徽标（改动面板的文件列表标识） */
const CHANGE_KIND_LABELS: Record<GitChangeKind, string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
};

const CHANGE_KIND_CLASSES: Record<GitChangeKind, string> = {
  added: 'bg-emerald-950 text-emerald-400 border-emerald-800',
  modified: 'bg-sky-950 text-sky-400 border-sky-800',
  deleted: 'bg-red-950 text-red-400 border-red-800',
  renamed: 'bg-violet-950 text-violet-400 border-violet-800',
};

/**
 * 改动面板（spec「结果检视与 git」）：工作区 git status 的变更文件列表 +
 * Monaco diff 检视 + 一键创建分支（codexlike/<会话名>）与一键提交。
 * 非 git 工作区显示降级提示，不报错。
 */
export function ChangesPanel(props: {
  sessionId: string;
  sessionTitle: string;
  selectedProfileId: string;
  onClose: () => void;
}) {
  const { sessionId, sessionTitle, selectedProfileId, onClose } = props;

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GitFileChange | null>(null);
  const [diffOriginal, setDiffOriginal] = useState('');
  const [diffModified, setDiffModified] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchFeedback, setBranchFeedback] = useState<string | null>(null);
  const [commitDraft, setCommitDraft] = useState('');
  const [commitBusy, setCommitBusy] = useState<'generate' | 'commit' | null>(null);
  const [commitFeedback, setCommitFeedback] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await window.codexlike.git.status(sessionId);
      setStatus(next);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    setSelected(null);
    setBranchFeedback(null);
    setCommitDraft('');
    setCommitFeedback(null);
  }, [refresh]);

  /** 点文件：加载单文件 diff（新旧两侧全文） */
  async function openFile(file: GitFileChange) {
    setSelected(file);
    setDiffError(null);
    setDiffLoading(true);
    try {
      const diff = await window.codexlike.git.diff(
        sessionId,
        file.path,
        file.oldPath,
      );
      setDiffOriginal(diff.original);
      setDiffModified(diff.modified);
    } catch (error) {
      setDiffError(error instanceof Error ? error.message : String(error));
    } finally {
      setDiffLoading(false);
    }
  }

  async function createBranch() {
    setBranchBusy(true);
    setBranchFeedback(null);
    try {
      const result = await window.codexlike.git.createBranch(sessionId);
      setBranchFeedback(
        result.created
          ? `已创建并切换到分支 ${result.branch}`
          : `分支已存在，已切换到 ${result.branch}`,
      );
      await refresh();
    } catch (error) {
      setBranchFeedback(
        `创建分支失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setBranchBusy(false);
    }
  }

  /** 模型按会话内容生成提交消息草稿（一次不发工具的请求；可编辑、失败可手写） */
  async function generateMessage() {
    setCommitBusy('generate');
    setCommitFeedback(null);
    try {
      const draft = await window.codexlike.git.generateCommitMessage(
        sessionId,
        selectedProfileId,
      );
      setCommitDraft(draft);
      setCommitFeedback(null);
    } catch (error) {
      setCommitFeedback(
        `${error instanceof Error ? error.message : String(error)}（可直接手动填写后提交）`,
      );
    } finally {
      setCommitBusy(null);
    }
  }

  async function commit() {
    if (commitDraft.trim() === '') {
      setCommitFeedback('提交消息不能为空');
      return;
    }
    setCommitBusy('commit');
    setCommitFeedback(null);
    try {
      const result = await window.codexlike.git.commit(
        sessionId,
        commitDraft.trim(),
      );
      if (result.committed) {
        setCommitFeedback(`已提交（${result.commitHash?.slice(0, 7) ?? ''}）`);
        setCommitDraft('');
      } else {
        setCommitFeedback(result.reason ?? '没有可提交的变更');
      }
      await refresh();
    } catch (error) {
      setCommitFeedback(
        `提交失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setCommitBusy(null);
    }
  }

  return (
    <aside
      data-testid="changes-panel"
      className="flex h-full w-[30rem] shrink-0 flex-col border-l border-slate-800 bg-slate-900"
    >
      <header className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
        {selected !== null ? (
          <>
            <button
              type="button"
              data-testid="changes-back"
              className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:border-sky-600 hover:text-sky-400"
              onClick={() => setSelected(null)}
            >
              ← 返回
            </button>
            <span
              data-testid="changes-diff-path"
              className="min-w-0 flex-1 truncate font-mono text-xs text-slate-300"
              title={selected.path}
            >
              {selected.path}
            </span>
          </>
        ) : (
          <>
            <span className="text-sm font-medium text-slate-200">
              改动（{status?.files.length ?? 0}）
            </span>
            {status?.isGitRepo === true && (
              <span
                data-testid="changes-branch"
                className="truncate rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-sky-300"
                title="当前分支"
              >
                {status.branch ?? '（无提交历史）'}
              </span>
            )}
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:border-sky-600 hover:text-sky-400 disabled:opacity-50"
            >
              刷新
            </button>
            <button
              type="button"
              data-testid="changes-close"
              onClick={onClose}
              className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:border-sky-600 hover:text-sky-400"
            >
              关闭
            </button>
          </>
        )}
      </header>

      {loadError !== null && status === null ? (
        <div className="m-3 rounded border border-red-900 bg-red-950/60 p-3 text-sm text-red-300">
          {loadError}
        </div>
      ) : status !== null && !status.isGitRepo ? (
        <div
          data-testid="changes-not-git"
          className="m-3 rounded border border-slate-700 bg-slate-950/60 p-3 text-sm text-slate-400"
        >
          非 git 工作区：当前会话绑定的目录不受 git 管理，无法查看改动或提交。
        </div>
      ) : selected !== null ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {diffLoading ? (
            <div className="p-3 text-sm text-slate-500">加载改动中…</div>
          ) : diffError !== null ? (
            <div className="m-3 rounded border border-red-900 bg-red-950/60 p-3 text-sm text-red-300">
              {diffError}
            </div>
          ) : (
            <div className="min-h-0 flex-1">
              <Suspense
                fallback={
                  <div className="p-3 text-sm text-slate-500">
                    加载 diff 视图…
                  </div>
                }
              >
                <MonacoDiff
                  original={diffOriginal}
                  modified={diffModified}
                  language={languageForPath(selected.path)}
                />
              </Suspense>
            </div>
          )}
        </div>
      ) : (
        <>
          <ul className="min-h-0 flex-1 overflow-auto py-1" data-testid="changes-file-list">
            {loading ? (
              <li className="px-3 py-2 text-sm text-slate-500">读取 git 状态中…</li>
            ) : (
              (status?.files ?? []).map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    data-testid="changes-file-item"
                    onClick={() => void openFile(file)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-800/60"
                  >
                    <span
                      className={`shrink-0 rounded border px-1.5 py-0.5 text-xs ${CHANGE_KIND_CLASSES[file.kind]}`}
                    >
                      {CHANGE_KIND_LABELS[file.kind]}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-300">
                      {file.path}
                    </span>
                  </button>
                </li>
              ))
            )}
            {!loading && (status?.files.length ?? 0) === 0 && (
              <li className="px-3 py-2 text-sm text-slate-500">
                工作区没有未提交的变更
              </li>
            )}
          </ul>

          <footer className="space-y-2 border-t border-slate-800 p-3">
            <button
              type="button"
              data-testid="changes-create-branch"
              onClick={() => void createBranch()}
              disabled={branchBusy}
              className="w-full rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:border-sky-600 hover:text-sky-400 disabled:opacity-50"
            >
              {branchBusy
                ? '创建中…'
                : `创建分支 ${codexlikeBranchName(sessionTitle)}`}
            </button>
            {branchFeedback !== null && (
              <p
                data-testid="changes-branch-feedback"
                className="text-xs text-emerald-400"
              >
                {branchFeedback}
              </p>
            )}

            <textarea
              data-testid="changes-commit-message"
              value={commitDraft}
              onChange={(event) => setCommitDraft(event.target.value)}
              placeholder="提交消息（可由模型生成，可编辑）"
              rows={2}
              className="w-full resize-none rounded border border-slate-700 bg-slate-950/70 p-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none"
            />
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="changes-generate-message"
                onClick={() => void generateMessage()}
                disabled={commitBusy !== null}
                className="flex-1 rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:border-sky-600 hover:text-sky-400 disabled:opacity-50"
              >
                {commitBusy === 'generate' ? '生成中…' : '生成提交消息'}
              </button>
              <button
                type="button"
                data-testid="changes-commit"
                onClick={() => void commit()}
                disabled={commitBusy !== null}
                className="flex-1 rounded border border-emerald-800 bg-emerald-950 px-3 py-1.5 text-sm text-emerald-300 hover:border-emerald-600 disabled:opacity-50"
              >
                {commitBusy === 'commit' ? '提交中…' : '提交全部变更'}
              </button>
            </div>
            {commitFeedback !== null && (
              <p
                data-testid="changes-commit-feedback"
                className="text-xs text-slate-400"
              >
                {commitFeedback}
              </p>
            )}
          </footer>
        </>
      )}
    </aside>
  );
}
