import type { ApprovalMode } from "./approval";
import type { ThinkingEffort } from "../provider/language-model";

/** 持久工作现场不包含执行状态、交互授权、provider 密钥或思考正文。 */
export type WorkbenchTarget =
  { kind: "new"; projectId: string | null } | { kind: "task"; taskId: string };

export interface TaskPreferences {
  providerProfileId: string;
  /**
   * 对下一条消息生效的具体模型（票 02，ADR 0024 二元组）：与
   * providerProfileId 成对。可选字段——旧持久化数据无此值（undefined
   * 等价未显式选择，发送时由 agent-core 回退 Profile 列表第一项）。
   */
  model?: string;
  thinkingEffort: ThinkingEffort;
  approvalMode: ApprovalMode;
}

export interface ReadingPosition {
  scrollTop: number;
  anchorId?: string;
  offset?: number;
  /** 离开时是否贴底跟随（票 03）：恢复时贴底记忆定位当前最新并跟随；
   *  旧数据无该字段时按像素位置恢复，行为与既有记忆一致。 */
  atBottom?: boolean;
}

export interface SavedQuestionDraft {
  index: number;
  answers: Record<
    string,
    {
      selectedOptionIds: string[];
      text: string;
      skipped: boolean;
    }
  >;
}

export interface WorkbenchValue {
  text: string;
  preferences: TaskPreferences;
  questionDrafts: Record<string, SavedQuestionDraft>;
  readingPosition: ReadingPosition | null;
  /** 新建入口的幂等意图；成功消费后更换，旧异步写不能复活它。 */
  requestId: string;
  workspacePath?: string;
  workspaceMode?: "local" | "worktree";
}

export interface WorkbenchEntry {
  revision: number;
  value: WorkbenchValue;
}

export function workbenchKey(target: WorkbenchTarget): string {
  return target.kind === "task"
    ? JSON.stringify(["task", target.taskId])
    : JSON.stringify(["new", target.projectId]);
}
