import type { DatabaseSync } from "node:sqlite";

/** 搜索只返回导航所需信息，不暴露模型配置、工作区文件或工具参数。 */
export interface TaskSearchResult {
  id: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  archivedAt: string | null;
}

/** 直接查询持久历史；EXISTS 保证同一会话多条消息命中也只返回一次。 */
export function createTaskSearch(db: DatabaseSync) {
  const statement = db.prepare(`
    SELECT s.id, s.title, s.project_id, p.name AS project_name, s.archived_at
    FROM tasks s LEFT JOIN projects p ON p.id = s.project_id
    WHERE (? = 1 OR s.archived_at IS NULL) AND (
      instr(lower(s.title), lower(?)) > 0 OR EXISTS (
        SELECT 1 FROM messages m
        WHERE m.task_id = s.id AND instr(lower(m.content), lower(?)) > 0
      )
    )
    ORDER BY s.pinned DESC, COALESCE(s.last_used_at, s.created_at) DESC,
      s.created_at DESC, s.id DESC
  `);
  return (query: string, includeArchived = false): TaskSearchResult[] => {
    const text = query.trim();
    if (!text) return [];
    return statement.all(includeArchived ? 1 : 0, text, text).map((row) => ({
      id: String(row.id),
      title: String(row.title),
      projectId: row.project_id === null ? null : String(row.project_id),
      projectName: row.project_name === null ? null : String(row.project_name),
      archivedAt: row.archived_at === null ? null : String(row.archived_at),
    }));
  };
}
