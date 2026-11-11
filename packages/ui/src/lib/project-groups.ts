import type { SessionRecord } from '@codexlike/agent-core';

/**
 * 项目组（GLOSSARY「项目」）：同一工作区目录上所有会话的聚合分组。
 * worktree 会话按其原始仓库路径归组（ADR 0005）；项目是纯派生视图，
 * 无持久实体——组随首个会话诞生，永不消失。
 */
export interface ProjectGroup {
  /** 规范化聚合键（统一 / 分隔、小写、去尾斜杠），组件作稳定 React key */
  key: string;
  /** 项目名：组内最早会话的原始路径目录名（保留用户可读大小写） */
  name: string;
  /** 组内最早会话的原始路径（未规范化，组头 tooltip 用） */
  path: string;
  /** 项目创建时间：组内最早会话的 createdAt（派生值） */
  createdAt: string;
  /** 活跃会话（archivedAt === null），组内按 updatedAt 倒序 */
  active: SessionRecord[];
  /** 已归档会话（archivedAt !== null），组内按 updatedAt 倒序 */
  archived: SessionRecord[];
}

/** 会话的聚合来源路径：worktree 的原始仓库路径，否则工作区路径（ADR 0005） */
function originPathOf(session: SessionRecord): string {
  return session.workspaceOriginPath ?? session.workspacePath;
}

/** 分隔符统一为 / 并去尾斜杠（保留原大小写，basename 用） */
function toPosix(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 聚合键：来源路径规范化（统一 / 分隔、去尾斜杠、小写归并大小写差异，story 18） */
function projectKeyOf(session: SessionRecord): string {
  return toPosix(originPathOf(session)).toLowerCase();
}

/** 目录名（跨平台分隔符；根路径等退化场景回退全路径） */
function basenameOf(path: string): string {
  const last = toPosix(path).split('/').filter(Boolean).pop();
  return last ?? path;
}

function byUpdatedAtDesc(a: SessionRecord, b: SessionRecord): number {
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

/** 会话列表 → 项目组列表（侧栏单一项目树的数据源） */
export function groupSessionsByProject(
  sessions: SessionRecord[],
): ProjectGroup[] {
  // 按 key 分桶（保留全部会话，组名从桶内最早会话派生，不随输入顺序抖动）
  const buckets = new Map<string, SessionRecord[]>();
  for (const session of sessions) {
    const key = projectKeyOf(session);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [session]);
    } else {
      bucket.push(session);
    }
  }

  const groups: ProjectGroup[] = [];
  for (const [key, bucket] of buckets) {
    // 组内最早会话 = 项目的诞生者：组名与 createdAt 都跟它走
    const born = bucket.reduce((earliest, candidate) =>
      candidate.createdAt < earliest.createdAt ? candidate : earliest,
    );
    const bornPath = originPathOf(born);
    groups.push({
      key,
      name: basenameOf(bornPath),
      path: bornPath,
      createdAt: born.createdAt,
      active: bucket
        .filter((session) => session.archivedAt === null)
        .sort(byUpdatedAtDesc),
      archived: bucket
        .filter((session) => session.archivedAt !== null)
        .sort(byUpdatedAtDesc),
    });
  }

  // 项目按创建时间倒序（最新开始的最上）；并列按聚合键字典序，排序稳定
  groups.sort((a, b) =>
    a.createdAt < b.createdAt
      ? 1
      : a.createdAt > b.createdAt
        ? -1
        : a.key < b.key
          ? -1
          : a.key > b.key
            ? 1
            : 0,
  );
  return groups;
}
