# 会话工作台实施任务索引

[正式规格](../spec.md)、九张票及依赖已获用户确认并授权实施。01–08 已独立交付并合入集成；09 已完成入口一致性、跨票组合与完整发布验收，等待协调者合入及独立代码审查。历史规格中的发布阶段说明保留，不删减用户故事或验收要求。

| 票号 | 任务                                                                           | 直接阻塞                   | 当前状态  |
| ---- | ------------------------------------------------------------------------------ | -------------------------- | --------- |
| 01   | [建立项目与独立会话的新建闭环](01-projects-and-standalone-creation.md)         | 无                         | completed |
| 02   | [切换会话时完整保留执行现场](02-live-session-switching.md)                     | 01                         | completed |
| 03   | [持久保存草稿、阅读位置与会话设置](03-persistent-drafts-and-preferences.md)    | 01                         | completed |
| 04   | [接入延迟创建的 Worktree 与共享目录提示](04-worktree-and-shared-workspace.md)  | 01                         | completed |
| 05   | [完成侧栏整理与归档恢复](05-sidebar-and-archive.md)                            | 01                         | completed |
| 06   | [加入跨项目会话搜索](06-cross-project-search.md)                               | 05                         | completed |
| 07   | [安全调整归属与移除项目](07-membership-and-project-removal.md)                 | 04、05                     | completed |
| 08   | [完成退出确认与重启恢复](08-exit-and-restart-recovery.md)                      | 02、03                     | completed |
| 09   | [统一所有入口并完成整体验收](09-entry-consistency-and-release-verification.md) | 02、03、04、05、06、07、08 | completed |

## 交付与验收

每张票均有自身纵向切片、真实红绿及实际检查记录；09 不替代各前置票测试。完整套件在 `packages/desktop/package.json` 的 `test:e2e:all`，包含 24 个专项脚本；产物冷启动另由 `test:e2e:packaged` 验证。用户故事到测试的精简覆盖映射、完整命令结果和环境限制统一记录在票 09。

新数据写入 `session-workbench.db`，旧库与旧 Worktree 原样保留。归档/移动/移除管理记录不删除磁盘文件，所有入口沿用宿主执行保护和首次发送契约。自动化通过不等于独立代码审查；集成后的 code-review 由主协调者另行执行。
