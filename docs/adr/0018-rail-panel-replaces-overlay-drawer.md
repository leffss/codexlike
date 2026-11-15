---
status: accepted
---

# 检视右栏：面板布局从 overlay 抽屉改为常驻可拖拽分栏

「规范与技能」与「改动」两面板自票03 起共用一个浮于消息流上方的 overlay 抽屉（30rem、上限 60% 容器宽、双 tab 互斥）。实测暴露三类问题：覆盖式浮层遮住正在阅读的消息上下文，看改动时对话被迫中断；30rem 固定宽在大屏浪费、在小屏挤压，diff 阅读宽度不可调；改动入口拆在两处（标题栏管规范、消息区胶囊管改动），语义碎。经四变体原型对比（分支 prototype/panels-redesign：A 常驻右栏 / B 底部工作台 / C 检视分屏 / 基线现状），用户选定变体 A 折叠进生产：**常驻右栏分栏**——默认关闭，打开时把消息流推窄（并列而非覆盖），中缝可拖拽调宽。

## 关键边界

- **开合**：标题栏「右栏开关」为唯一入口（panel-right 图标，展开态 accent 高亮）；右栏默认关闭，关闭时组件保持挂载、节点整体卸载——git 状态 hook 照常随 changesRevision 轮换，标题栏角标在关闭期间仍刷新；卸载（而非 display:none 分隔条）同时保证正文列与输入框/审批框回到同一居中基准（分隔条 6px 占位会造成 6px 错位）。原消息区「改动」胶囊移除，计数语义并入开关角标。
- **计数角标**：未提交变更文件数挂开关右上角（>0 显示、>99 折叠 99+、非 git/无任务不显示，aria 同步）；精确数在右栏「改动」tab 按钮上紧跟标题（无截断）。角标数据来自右栏的 git 状态 hook 上报，不重复请求。
- **拖拽分栏**：右栏最小宽 320、正文最小宽 480，拖动中双端夹取（上限优先——窄容器下右栏跟随收窄保布局不溢出）；双击复位默认宽 400；分隔条可 Tab 聚焦、←/→ 每次 ±24px。打开瞬间把记忆宽度夹到当前容器上限（窄窗口 400 默认宽会压穿正文 480 底线）。宽度为会话内存态，不持久化。
- **tab 单屏**：「改动」「规范与技能」恢复 tab 互斥（原型期曾做上下折叠同屏，用户否决），tab 头为独立描边按钮（对标标题栏开关样式）；改动 tab 结构＝分支行（当前分支 + 行尾刷新）→ 文件清单 → 选中文件 diff → 提交动作组；规范 tab＝三档快照 chips（本轮/上轮/下轮预览，GLOSSARY「资源快照」）+ 密排摘要，取代原三卡片同屏堆叠。
- **分档宽度不受影响**：`@container/task` 容器（中栏）宽度不因右栏开合改变，ADR 0011 三档分档行为稳定；右栏是容器内兄弟节点，打开只推窄消息流列。
- **任务搜索迁位**：标题栏任务搜索图标迁任务列表头部（「添加项目」之前），弹层 fixed 定位不变；标题栏腾出的位置即右栏开关。

## 取舍

- 拒绝「右栏内自带关闭钮」：开合入口收口到标题栏单一来源，右栏内部只承载内容；键盘/aria 语义由开关的 aria-expanded 承担。
- 拒绝「打开时记住上次 tab 并持久化宽度」：会话内存态足够（重启回默认关闭+改动 tab+400px），持久化引入跨会话布局漂移的排查成本；tab 在组件挂载期保持（关再开不丢）。
- 草稿态（无任务）右栏可用：资源预览走 draft 管线，改动 tab 显示占位提示；仅「无任务且草稿未选工作区」时开关禁用（与原抽屉语义一致）。
- WorkPlanBanner 的 fixed 进度环与右栏无层叠冲突（右栏不再覆盖消息流）；方案 B（底部工作台）与 fixed 悬浮件的冲突是其落选原因之一。

影响面：ui 新增 RailPanel/GitActions/ResourceSnapshotSummary 三组件，删除原抽屉系四组件（PanelsDrawer/AgentResourcesPanel/ChangesPanel/ChangesChip）；TitlebarPanels 改右栏语义（open/onToggle/changesCount，去 search）；TaskSidebar 头部内嵌 TaskSearch；WorkspacePage 消息区改「流 + 右栏」行布局；browser-stub 的 git.diff 返回值修正为 IPC 契约形状（GitFileDiff{path,original,modified}，原 oldText/newText 为历史笔误——纯浏览器预览的改动面板 diff 一直没通过）；e2e 的 changes/skills/width-tiers/packaged/acceptance 改走右栏交互（helpers 新增 openRailPanel/closeRailPanel）。
