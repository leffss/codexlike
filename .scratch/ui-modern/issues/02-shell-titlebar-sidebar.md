# 02: 工作台外壳——标题栏 / 侧栏 / 窗口控制

**What to build:** 工作台 chrome 换 D 语言：标题栏去底色底边融入画布、按钮统一浅淡无边框；侧栏透明无色块、任务行 hover 浮现暖灰圆角底、当前任务用暖灰底+字重（非彩色胶囊）；项目分组、worktree/本地徽章、排队/运行/等待/未读徽章在暖色体系下一眼可辨；窗口控制按钮 hover 统一。

**Blocked by:** 01（token 基座）

**Status:** ready-for-agent

- [ ] 标题栏（window-titlebar）融入画布：去底边框，任务上下文行/主题切换/设置/窗口控制统一浅淡样式
- [ ] 侧栏透明底：任务行 hover 暖灰圆角底、选中态暖灰底+字重，重命名输入白底深描边
- [ ] 全部徽章（worktree/排队/运行/等待用户/未读/项目计数）暖色下语义可辨
- [ ] 分组折叠/右键菜单入口/任务搜索入口/归档区行为不变（只动样式）
- [ ] ui 单测全绿
- [ ] e2e 实跑绿：projects-sidebar / sidebar-archive / task-search / theme
- [ ] dev 双主题走查截图留证

## Comments
