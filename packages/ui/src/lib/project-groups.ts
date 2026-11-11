import type { ProjectRecord, SessionRecord } from "@codexlike/agent-core";

/** 只按显式归属分区；独立分区不是项目实体，空项目也始终保留。 */
export interface ProjectGroup {
  key: string;
  projectId: string | null;
  name: string;
  path: string;
  createdAt: string;
  active: SessionRecord[];
  archived: SessionRecord[];
}
export function groupSessionsByProject(
  sessions: SessionRecord[],
  projects: ProjectRecord[]
): ProjectGroup[] {
  const groups: ProjectGroup[] = [
    {
      key: "standalone",
      projectId: null,
      name: "独立会话",
      path: "",
      createdAt: "",
      active: [],
      archived: [],
    },
    ...projects.map((project) => ({
      key: project.id,
      projectId: project.id,
      name: project.name,
      path: project.workspacePath,
      createdAt: project.createdAt,
      active: [],
      archived: [],
    })),
  ];
  for (const group of groups) {
    const members = sessions
      .filter((session) => session.projectId === group.projectId)
      .sort(
        (a, b) =>
          Number(b.pinned ?? false) - Number(a.pinned ?? false) ||
          (b.lastUsedAt ?? b.createdAt).localeCompare(
            a.lastUsedAt ?? a.createdAt
          ) ||
          b.createdAt.localeCompare(a.createdAt) ||
          b.id.localeCompare(a.id)
      );
    group.active = members.filter((session) => session.archivedAt === null);
    group.archived = members.filter((session) => session.archivedAt !== null);
  }
  return groups;
}
