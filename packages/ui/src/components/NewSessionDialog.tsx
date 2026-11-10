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
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70"
    >
      <div className="w-[28rem] rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-xl">
        <h3 className="text-base font-medium text-slate-100">新建会话</h3>
        <p
          data-testid="new-session-workspace"
          className="mt-2 truncate rounded bg-slate-950 px-3 py-2 text-xs text-slate-400"
          title={props.workspacePath}
        >
          工作区：{props.workspacePath}
        </p>
        <fieldset className="mt-4 space-y-2">
          <legend className="text-sm text-slate-300">运行位置</legend>
          <label
            data-testid="mode-local"
            className={`flex cursor-pointer items-start gap-2 rounded border px-3 py-2 ${
              mode === 'local' ? 'border-sky-600 bg-sky-900/20' : 'border-slate-700'
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
              <span className="block text-sm text-slate-200">本目录直跑（默认）</span>
              <span className="block text-xs text-slate-500">
                直接在所选目录中读写文件与执行命令
              </span>
            </span>
          </label>
          <label
            data-testid="mode-worktree"
            className={`flex cursor-pointer items-start gap-2 rounded border px-3 py-2 ${
              mode === 'worktree' ? 'border-sky-600 bg-sky-900/20' : 'border-slate-700'
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
              <span className="block text-sm text-slate-200">worktree 模式</span>
              <span className="block text-xs text-slate-500">
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
            className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-500"
            onClick={props.onCancel}
            disabled={props.creating}
          >
            取消
          </button>
          <button
            type="button"
            data-testid="create-session-confirm"
            className="rounded bg-sky-700 px-3 py-1.5 text-sm text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
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
