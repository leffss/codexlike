import { useState } from 'react';

import type { WorkspaceMode } from '@codexlike/agent-core';

/**
 * 新建会话对话框（工单 09 托管 Worktree）：选定工作区目录后选择运行位置——
 * 「本目录直跑」（默认）或「worktree 模式」（在 ~/.codexlike/worktrees/<会话id>
 * 检出隔离副本与独立分支，同仓库多会话并行互不冲突）。
 * 非 git 目录选 worktree 由主进程报错（会话不创建），对话框内不重复校验。
 */
export function NewSessionDialog(props: {
  workspacePath: string;
  onCreate: (mode: WorkspaceMode) => void;
  onCancel: () => void;
  /** 创建请求进行中（按钮禁用防重复提交） */
  creating: boolean;
}) {
  const [mode, setMode] = useState<WorkspaceMode>('local');

  return (
    <div
      data-testid="new-session-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
    >
      <div className="w-[28rem] rounded-lg border border-line bg-surface p-5 shadow-xl">
        <h3 className="text-base font-medium text-fg">新建会话</h3>
        <p
          data-testid="new-session-workspace"
          className="mt-2 truncate rounded bg-code-bg px-3 py-2 text-xs text-fg-muted"
          title={props.workspacePath}
        >
          工作区：{props.workspacePath}
        </p>
        <fieldset className="mt-4 space-y-2">
          <legend className="text-sm text-fg-muted">运行位置</legend>
          <label
            data-testid="mode-local"
            className={`flex cursor-pointer items-start gap-2 rounded border px-3 py-2 ${
              mode === 'local' ? 'border-accent bg-selected' : 'border-line'
            }`}
          >
            <input
              type="radio"
              name="workspace-mode"
              className="mt-1"
              checked={mode === 'local'}
              onChange={() => setMode('local')}
            />
            <span>
              <span className="block text-sm text-fg">本目录直跑（默认）</span>
              <span className="block text-xs text-fg-subtle">
                直接在所选目录中读写文件与执行命令
              </span>
            </span>
          </label>
          <label
            data-testid="mode-worktree"
            className={`flex cursor-pointer items-start gap-2 rounded border px-3 py-2 ${
              mode === 'worktree' ? 'border-accent bg-selected' : 'border-line'
            }`}
          >
            <input
              type="radio"
              name="workspace-mode"
              className="mt-1"
              checked={mode === 'worktree'}
              onChange={() => setMode('worktree')}
            />
            <span>
              <span className="block text-sm text-fg">worktree 模式</span>
              <span className="block text-xs text-fg-subtle">
                在托管 Worktree 隔离副本上运行（独立分支，需 git 仓库）；
                项目根 .worktreeinclude 列出的被忽略文件会复制进副本
              </span>
            </span>
          </label>
        </fieldset>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="create-session-cancel"
            className="rounded border border-line px-3 py-1.5 text-sm text-fg-muted hover:border-fg-muted"
            onClick={props.onCancel}
            disabled={props.creating}
          >
            取消
          </button>
          <button
            type="button"
            data-testid="create-session-confirm"
            className="rounded bg-accent px-3 py-1.5 text-sm text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => props.onCreate(mode)}
            disabled={props.creating}
          >
            {props.creating ? '创建中…' : '创建会话'}
          </button>
        </div>
      </div>
    </div>
  );
}
