# 项目侧边栏（Projects Sidebar）

Status: ready-for-agent

## Problem Statement

用户的会话按工作区目录重复打开：同一个代码库今天一个会话、明天又一个，侧边栏是一张不断增长、无结构的平铺会话列表。想回到「上次在 ai-agent 仓库干了什么」，只能靠逐条读会话标题或悬停看目录 tooltip；worktree 模式的隔离实验会话更是散落各处，与主线会话毫无关联。会话多了以后，列表失去导航能力。

## Solution

引入「项目」：同一工作区目录上所有会话（含在该目录上检出的托管 Worktree 会话）的聚合分组。侧边栏从平铺列表改为单一项目树——项目组为一级（可折叠），活跃会话挂在组内（保持现有排序），归档会话收进组内「已归档」子折叠，底部独立归档区取消。项目完全由会话数据自动派生，用户不创建、不归类、不维护：新建会话选了目录，项目就出现；组头常驻，项目永不消失。项目级指令不做——AGENTS.md 的目录级发现机制已是既有的「项目级上下文」。

## User Stories

1. As a 用户, I want 同一工作区目录的所有会话在侧边栏聚成一个项目组, so that 一眼看出哪些会话属于哪个代码库。
2. As a 用户, I want 项目组按项目创建时间倒序排列, so that 最近开始的项目排在最上，最快回到手头的工作。
3. As a 用户, I want 项目组内的活跃会话保持最近活跃倒序, so that 组内最常用的会话始终在顶部。
4. As a 用户, I want 每个项目组可折叠/展开, so that 收起当前不关心的项目、专注在手头的组。
5. As a 用户, I want 项目组头显示项目名（目录名）, so that 无需悬停即可识别每个组。
6. As a 用户, I want 项目组头显示活跃与归档会话计数, so that 不展开也能了解各项目状态。
7. As a 用户, I want worktree 模式的会话归入其原始仓库的项目组, so that 隔离实验与主线会话在同一项目下一起可见。
8. As a 用户, I want 旧库中无 origin 信息的存量 worktree 会话按其 worktree 路径独立成组且应用不崩溃, so that 升级后历史数据仍可访问。
9. As a 用户, I want 归档的会话收进所属项目组内的「已归档」子折叠, so that 归档不丢项目上下文、也不占活跃区。
10. As a 用户, I want 所有会话都归档后项目组头仍然显示, so that 只归档过会话的项目不会从侧边栏消失。
11. As a 用户, I want 在组内「已归档」子折叠里一键取消归档, so that 会话回到该组活跃区继续工作。
12. As a 用户, I want 归档/取消归档后项目排序保持稳定, so that 列表不因日常操作而跳动。
13. As a 用户, I want 新建会话选定工作区目录后它自动出现在对应项目组（目录首次出现即新建组）, so that 不需要任何手动建项目或归类操作。
14. As a 用户, I want 新建对话框保持现状（选目录 + local/worktree 模式）, so that 项目功能不增加创建步骤。
15. As a 用户, I want 在项目组内照旧重命名、归档、切换审批模式、压缩, so that 分组不改变任何既有会话操作。
16. As a 用户, I want 当前选中的会话所在项目组保持展开, so that 折叠过的组里有会话被激活时我不会失联。
17. As a 用户, I want 重启应用后项目分组与排序完全一致, so that 侧边栏是稳定的空间记忆。
18. As a 用户, I want 同一目录以不同大小写/分隔符写法被选两次时仍归入同一项目, so that Windows 路径差异不会把一个项目拆成两个。

## Implementation Decisions

- **项目是纯派生视图**：不建 projects 表、项目无持久实体、无自己的生命周期；分组在渲染层由会话列表按聚合键 groupBy 派生。将来若需要重命名或项目级设置，按聚合键一次性 seed 成实体表（ADR 0004 已记此路径）。
- **sessions 表新增 `workspace_origin_path` 列**（nullable）：worktree 模式创建会话时写入用户所选的原仓库路径，local 模式写 null。迁移沿用现有启动时 try/catch `ALTER TABLE ADD COLUMN` 模式，不引入编号迁移系统。
- **聚合键 = `workspace_origin_path ?? workspacePath`**，聚合前对路径做规范化（统一分隔符与大小写），确保同一目录的不同写法归为一组；项目名 = 组内最早会话原始路径的目录 basename（保留大小写，不取小写聚合键）。
- **项目创建时间 = 组内最早会话的 createdAt**（派生值，无独立存储）；项目按此倒序，并列时按聚合键字典序稳定排序。
- **归档重构为组内子折叠**：归档会话从组内活跃区移入组内「已归档」子折叠，底部独立归档区取消；归档/取消归档不影响项目排序（排序键是 createdAt，不是 updatedAt）。
- **折叠状态**：组折叠与归档子折叠均为组件内 state，不持久化（与现状一致）；初始渲染时含当前选中会话的项目组保持展开。
- **创建流程零改动**：新建对话框不动；worktree 创建编排（worktree 模式的会话创建流程）在 worktree 分支补写 origin，local 分支写 null；会话恢复与列表接口透传 origin 字段供 UI 聚合。
- **E2E testid 迁移**：`archived-list` / `toggle-archived` / `unarchive-button` / `archived-` 系列语义保留、位置移入各组内；新增项目组维度的 testid；`session-item` / `session-list` 等保留。

## Testing Decisions

- 只测外部行为：store 层测「写入后读回」「旧库升级后可读」；编排层测「worktree 创建的落库记录含正确 origin」；分组层测「给定会话集合 → 期望分组结构」。不测 SQL 文本、内部函数拆分等实现细节。
- **接缝 A（沿用）**：sqlite 内存库 store 测试。旧库场景先以旧 schema（无 origin 列）建库插入会话，再以新代码打开，验证 ALTER 升级生效、存量行读出 null。
- **接缝 B（沿用）**：worktree 创建编排注入 fake 的 service 与 manager，断言两种模式落库的 origin 字段。
- **接 seam C（新，浅）**：分组纯函数单测（ui 既有函数测试风格）：排序规则、路径规范化归组、worktree origin 归组、null 退化独立成组、全归档组保留、活跃/归档分流的输出结构。
- **E2E**：更新现有归档用例至组内子折叠结构；新增双目录分组冒烟（两个临时目录各建一个会话，断言出现两个项目组、组名为目录名）。
- 现有全量单测与 E2E 保持通过。

## Out of Scope

- 项目重命名、自定义颜色/图标（纯派生的直接推论）
- 会话删除（维持只有归档）
- 拖拽排序、手动置顶
- 应用内项目级 instructions / 项目级设置（默认审批模式、默认模型等；交给 AGENTS.md 目录机制）
- 项目内搜索
- 「最近工作区」快捷下拉（记为后续独立增强）
- 折叠状态持久化
- 项目切换器形态

## Further Notes

- 领域依据：GLOSSARY「项目（Project）」词条（本次新增）与「工作区（Workspace）」词条；ADR `0005-worktree-sessions-aggregate-by-origin-path.md`（0004 已被审批三档重构占用）。
- 「项目级上下文」的既定答案：AGENTS.md 目录发现（全局 → git 根 → 逐层目录）已是项目级指令机制，应用内不再造第二处真相。
- 本 spec 由 grill-with-docs 会话产出：全部决策（Q1–Q9）已与用户逐条确认。
