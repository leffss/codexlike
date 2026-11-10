import { randomUUID } from 'node:crypto';

import type {
  SessionManager,
  SessionRecord,
  WorktreeService,
} from '@codexlike/agent-core/node';

/**
 * 新建会话的模式编排（工单 09 托管 Worktree）：
 * - `local`（默认）：本目录直跑，workspacePath 即用户所选目录；
 * - `worktree`：先检出托管 Worktree（目录名=会话 id、独立分支 codexlike/<会话 id>），
 *   再以同一会话 id 落库——worktree 检出失败（非 git 目录等）以中文异常抛回且
 *   会话不落库（渲染层提示后用户可改选本目录直跑）。
 *
 * 从 session-ipc 抽出为独立模块：编排逻辑可脱离 Electron IPC 单测。
 */
export async function createSessionWithMode(options: {
  manager: SessionManager;
  worktreeService: WorktreeService;
  workspacePath: string;
  workspaceMode?: 'local' | 'worktree';
  /** 会话 id 生成器（默认 randomUUID；测试可注入固定 id） */
  generateId?: () => string;
}): Promise<SessionRecord> {
  const { manager, worktreeService, workspacePath } = options;
  const mode = options.workspaceMode ?? 'local';
  const generateId = options.generateId ?? randomUUID;

  if (mode === 'local') {
    return manager.create({ workspacePath }).record;
  }
  // worktree 模式：先检出副本（失败即抛出、不落库），再以同一 id 创建会话
  const sessionId = generateId();
  const worktree = await worktreeService.createForSession({
    sessionId,
    workspacePath,
  });
  return manager.create({
    id: sessionId,
    workspacePath: worktree.path,
    workspaceMode: 'worktree',
  }).record;
}
