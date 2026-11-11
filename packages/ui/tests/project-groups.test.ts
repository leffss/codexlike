import type { ProjectRecord, SessionRecord } from "@codexlike/agent-core";
import { expect, it } from "vitest";
import { groupSessionsByProject } from "../src/lib/project-groups";

const project: ProjectRecord = {
  id: "project",
  name: "项目",
  workspacePath: "C:/work/demo",
  createdAt: "2026-11-11T00:00:00Z",
};
function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session",
    projectId: null,
    title: "会话",
    workspacePath: project.workspacePath,
    workspaceMode: "local",
    workspaceOriginPath: null,
    providerProfileId: null,
    model: null,
    status: "idle",
    approvalMode: "ask",
    archivedAt: null,
    createdAt: project.createdAt,
    updatedAt: project.createdAt,
    ...overrides,
  };
}
it("显式项目在没有会话时仍显示，独立分区不伪造成项目", () => {
  expect(
    groupSessionsByProject([], [project]).map((group) => [
      group.projectId,
      group.name,
      group.active.length,
    ])
  ).toEqual([
    [null, "独立会话", 0],
    ["project", "项目", 0],
  ]);
});
it("相同目录及 Worktree 来源不推导归属，只有 projectId 决定所属分区", () => {
  const groups = groupSessionsByProject(
    [
      session({ id: "standalone" }),
      session({ id: "local", projectId: project.id }),
      session({
        id: "detached",
        workspaceMode: "worktree",
        workspacePath: "C:/worktrees/wt",
        workspaceOriginPath: project.workspacePath,
      }),
    ],
    [project]
  );
  expect(groups[0]!.active.map((item) => item.id)).toEqual([
    "standalone",
    "detached",
  ]);
  expect(groups[1]!.active.map((item) => item.id)).toEqual(["local"]);
});
it("各分区分别保留归档历史并按时间排序，不丢失空项目", () => {
  const groups = groupSessionsByProject(
    [
      session({
        id: "old",
        lastUsedAt: "2026-11-10T00:00:00Z",
        updatedAt: "2026-11-12T00:00:00Z",
      }),
      session({ id: "archived", archivedAt: project.createdAt }),
      session({ id: "recent" }),
    ],
    [project]
  );
  expect(groups[0]!.active.map((item) => item.id)).toEqual(["recent", "old"]);
  expect(groups[0]!.archived.map((item) => item.id)).toEqual(["archived"]);
  expect(groups[1]!.active).toEqual([]);
});
