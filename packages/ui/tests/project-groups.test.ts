import type { ProjectRecord, TaskRecord } from "@codexlike/agent-core";
import { expect, it } from "vitest";
import { groupTasksByProject } from "../src/lib/project-groups";

const project: ProjectRecord = {
  id: "project",
  name: "项目",
  workspacePath: "C:/work/demo",
  createdAt: "2026-11-11T00:00:00Z",
};
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task",
    projectId: null,
    title: "任务",
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
it("显式项目在没有任务时仍显示，独立分区不伪造成项目", () => {
  expect(
    groupTasksByProject([], [project]).map((group) => [
      group.projectId,
      group.name,
      group.active.length,
    ])
  ).toEqual([
    ["project", "项目", 0],
    [null, "独立任务", 0],
  ]);
});
it("相同目录及 Worktree 来源不推导归属，只有 projectId 决定所属分区", () => {
  const groups = groupTasksByProject(
    [
      task({ id: "standalone" }),
      task({ id: "local", projectId: project.id }),
      task({
        id: "detached",
        workspaceMode: "worktree",
        workspacePath: "C:/worktrees/wt",
        workspaceOriginPath: project.workspacePath,
      }),
    ],
    [project]
  );
  expect(groups[1]!.active.map((item) => item.id)).toEqual([
    "standalone",
    "detached",
  ]);
  expect(groups[0]!.active.map((item) => item.id)).toEqual(["local"]);
});
it("各分区分别保留归档历史并按时间排序，不丢失空项目", () => {
  const groups = groupTasksByProject(
    [
      task({
        id: "old",
        lastUsedAt: "2026-11-10T00:00:00Z",
        updatedAt: "2026-11-12T00:00:00Z",
      }),
      task({ id: "archived", archivedAt: project.createdAt }),
      task({ id: "recent" }),
    ],
    [project]
  );
  expect(groups[1]!.active.map((item) => item.id)).toEqual(["recent", "old"]);
  expect(groups[1]!.archived.map((item) => item.id)).toEqual(["archived"]);
  expect(groups[0]!.active).toEqual([]);
});
it("置顶项目在普通项目前，同类保持输入顺序，取消置顶恢复创建顺序且不改变输入", () => {
  const projects = [
    { ...project, id: "a" },
    { ...project, id: "b", pinned: true },
    { ...project, id: "c" },
    { ...project, id: "d", pinned: true },
  ];
  expect(groupTasksByProject([], projects).map((group) => group.key)).toEqual([
    "b",
    "d",
    "a",
    "c",
    "standalone",
  ]);
  expect(projects.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
  expect(
    groupTasksByProject(
      [],
      projects.map((item) => ({ ...item, pinned: false }))
    ).map((group) => group.key)
  ).toEqual(["a", "b", "c", "d", "standalone"]);
});
