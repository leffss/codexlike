import type { ProjectRecord, TaskRecord } from "@codexlike/agent-core";

/** 只按显式归属分区；独立分区不是项目实体，空项目也始终保留。 */
export interface ProjectGroup {
  key: string;
  projectId: string | null;
  name: string;
  path: string;
  createdAt: string;
  active: TaskRecord[];
  archived: TaskRecord[];
}
export function groupTasksByProject(
  tasks: TaskRecord[],
  projects: ProjectRecord[]
): ProjectGroup[] {
  const groups: ProjectGroup[] = [
    ...[...projects]
      .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false))
      .map((project) => ({
        key: project.id,
        projectId: project.id,
        name: project.name,
        path: project.workspacePath,
        createdAt: project.createdAt,
        active: [],
        archived: [],
      })),
    {
      key: "standalone",
      projectId: null,
      name: "独立任务",
      path: "",
      createdAt: "",
      active: [],
      archived: [],
    },
  ];
  for (const group of groups) {
    const members = tasks
      .filter((task) => task.projectId === group.projectId)
      .sort(
        (a, b) =>
          Number(b.pinned ?? false) - Number(a.pinned ?? false) ||
          (b.lastUsedAt ?? b.createdAt).localeCompare(
            a.lastUsedAt ?? a.createdAt
          ) ||
          b.createdAt.localeCompare(a.createdAt) ||
          b.id.localeCompare(a.id)
      );
    group.active = members.filter((task) => task.archivedAt === null);
    group.archived = members.filter((task) => task.archivedAt !== null);
  }
  return groups;
}
