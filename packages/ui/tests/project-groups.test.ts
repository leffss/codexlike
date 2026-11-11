import type { SessionRecord } from '@codexlike/agent-core';
import { describe, expect, it } from 'vitest';

import { groupSessionsByProject } from '../src/lib/project-groups';

/** 最小合法会话记录（GLOSSARY「会话」；固定时间戳避免测试不稳定） */
function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's1',
    title: '会话',
    workspacePath: 'C:\\work\\demo',
    workspaceMode: 'local',
    workspaceOriginPath: null,
    providerProfileId: null,
    model: null,
    status: 'idle',
    approvalMode: 'assist',
    archivedAt: null,
    createdAt: '2026-11-10T08:00:00.000Z',
    updatedAt: '2026-11-10T08:00:00.000Z',
    ...overrides,
  };
}

describe('groupSessionsByProject（项目聚合分组，ADR 0005）', () => {
  it('同一工作区目录的会话归入同一项目组，组名取目录名', () => {
    const groups = groupSessionsByProject([
      session({ id: 'a', workspacePath: 'C:\\work\\demo' }),
      session({
        id: 'b',
        workspacePath: 'C:\\work\\demo',
        createdAt: '2026-11-10T09:00:00.000Z',
        updatedAt: '2026-11-10T09:00:00.000Z',
      }),
      session({ id: 'c', workspacePath: 'D:\\other\\site' }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.name)).toEqual(
      expect.arrayContaining(['demo', 'site']),
    );
    const demo = groups.find((g) => g.name === 'demo')!;
    expect(demo.active.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(groups.find((g) => g.name === 'site')!.active.map((s) => s.id)).toEqual(['c']);
  });

  it('worktree 会话按原始仓库路径归入所属项目；旧库无 origin 的按副本路径独立成组', () => {
    const groups = groupSessionsByProject([
      session({ id: 'local', workspacePath: 'C:\\work\\demo' }),
      session({
        id: 'wt',
        workspaceMode: 'worktree',
        workspacePath: 'C:\\home\\.codexlike\\worktrees\\wt',
        workspaceOriginPath: 'C:\\work\\demo',
      }),
      session({
        id: 'legacy-wt',
        workspaceMode: 'worktree',
        workspacePath: 'C:\\home\\.codexlike\\worktrees\\legacy-wt',
        workspaceOriginPath: null,
      }),
    ]);

    const demo = groups.find((g) => g.name === 'demo')!;
    expect(demo.active.map((s) => s.id).sort()).toEqual(['local', 'wt']);
    expect(groups.find((g) => g.name === 'legacy-wt')).toBeDefined();
  });

  it('项目按创建时间（组内最早 createdAt）倒序；并列按聚合键字典序；组内更晚的会话不改变组的创建时间', () => {
    const groups = groupSessionsByProject([
      session({ id: 'old-a', workspacePath: 'C:\\work\\alpha', createdAt: '2026-11-01T00:00:00.000Z' }),
      session({ id: 'new-b', workspacePath: 'D:\\work\\beta', createdAt: '2026-11-05T00:00:00.000Z' }),
      session({ id: 'mid-c', workspacePath: 'E:\\work\\gamma', createdAt: '2026-11-03T00:00:00.000Z' }),
      session({
        id: 'old-a-2',
        workspacePath: 'C:\\work\\alpha',
        createdAt: '2026-11-02T00:00:00.000Z',
        updatedAt: '2026-11-06T00:00:00.000Z',
      }),
      session({ id: 'tie-d', workspacePath: 'D:\\work\\delta', createdAt: '2026-11-05T00:00:00.000Z' }),
    ]);

    expect(groups.map((g) => g.name)).toEqual(['beta', 'delta', 'gamma', 'alpha']);
  });

  it('组内活跃与归档各自按 updatedAt 倒序（不依赖输入顺序）；归档会话不进活跃列表', () => {
    const groups = groupSessionsByProject([
      session({
        id: 'archived-old',
        workspacePath: 'C:\\work\\demo',
        archivedAt: '2026-11-09T00:00:00.000Z',
        updatedAt: '2026-11-10T07:00:00.000Z',
      }),
      session({ id: 'stale', workspacePath: 'C:\\work\\demo', updatedAt: '2026-11-10T09:00:00.000Z' }),
      session({
        id: 'archived-recent',
        workspacePath: 'C:\\work\\demo',
        archivedAt: '2026-11-10T08:00:00.000Z',
        updatedAt: '2026-11-10T12:00:00.000Z',
      }),
      session({ id: 'fresh', workspacePath: 'C:\\work\\demo', updatedAt: '2026-11-10T10:00:00.000Z' }),
    ]);

    const demo = groups[0]!;
    expect(demo.active.map((s) => s.id)).toEqual(['fresh', 'stale']);
    expect(demo.archived.map((s) => s.id)).toEqual(['archived-recent', 'archived-old']);
  });

  it('同一目录不同写法（大小写、分隔符、尾斜杠）归入同一项目；组名取组内最早会话的目录名（保大小写）', () => {
    const groups = groupSessionsByProject([
      session({ id: 'a', workspacePath: 'c:/work/demo/', createdAt: '2026-11-10T08:00:00.000Z' }),
      session({ id: 'b', workspacePath: 'C:\\Work\\Demo', createdAt: '2026-11-10T07:00:00.000Z' }),
      session({ id: 'c', workspacePath: 'C:/work/DEMO', createdAt: '2026-11-10T09:00:00.000Z' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe('Demo');
  });

  it('组内会话全部归档后项目组仍保留（组头常驻，项目永不消失）', () => {
    const groups = groupSessionsByProject([
      session({
        id: 'a',
        workspacePath: 'C:\\work\\demo',
        archivedAt: '2026-11-10T08:00:00.000Z',
        updatedAt: '2026-11-10T08:00:00.000Z',
      }),
      session({
        id: 'b',
        workspacePath: 'C:\\work\\demo',
        archivedAt: '2026-11-10T09:00:00.000Z',
        updatedAt: '2026-11-10T09:00:00.000Z',
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.active).toEqual([]);
    expect(groups[0]!.archived.map((s) => s.id)).toEqual(['b', 'a']);
  });
});
