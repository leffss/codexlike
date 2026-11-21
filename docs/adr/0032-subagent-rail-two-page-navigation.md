# 子代理 tab 拆页导航：分组列表页 ↔ 详情页

右栏「子代理」tab 体经两轮演进（ADR 0020 主从分栏；prototype/subagent-hierarchy 变体 C 转正为摘要选择器 + 浮层）后，实际使用发现一个页面既显示列表（摘要行 + 当前行）又显示内容（详情），视觉权重纠缠不够美观，且浮层列表是临时覆盖而非页面。本轮三变体原型对比（prototype/subagent-nav：A 紧凑列表两页导航 / B 主从双列常驻 / C 分组富行列表 + 连续阅读详情），用户选定 C，并追加三点评审反馈：分组标题强化、详情顶栏显示子代理标题、主代理标记行点击直跳对应详情。

决定：tab 体拆为两页互斥。列表页为默认入口——顶部计数摘要行（总数 + 进行中/排队/失败中断非零计数）+ 按状态分组（进行中 → 排队 → 已完成 → 失败与中断，空组不渲染），组头 accent 竖条 + 加粗标签 + accent 计数章；行两行式富行（任务名两行截断 + title 承载全文 + 状态/用时/工具数/报告字数元信息）。详情页顶栏「← 返回列表」+ 状态点 + 子代理标题 + ‹ i/N › 全列表顺序连续翻看（首尾禁用不环绕），正文区（SubagentDetail）不变。标记行点击 focus 直跳详情页，不落列表页。

取舍：拒绝 B 主从双列——400px 栏宽下列列压到 ~8 字宽，双列同时可见的优势被挤压抵消；拒绝 A 紧凑单行列表页——拆页后列表页升为一等页面，单行截断浪费了它可承载的密度，分组富行在多子代理时扫读效率更高，详情侧连续翻看补足横向比对诉求。focus 直跳语义沿用「直接选中并显示详情」（2026-11-19 定案），落点从浮层自动展开改为直跳详情页。分组以状态为轴而非时间轴：检视场景按「哪些还在跑、哪些失败了」扫读，委派时序由消息流标记行承担。

影响面：SubagentRailPanelBody 重写（摘要行/当前行/浮层/Escape 出口退役），行 testid `subagent-rail-item` 语义迁到列表页行（data-subagent-state 保留），新增 `subagent-rail-back/title/detail-header/pager-prev/pager-label/pager-next/group-header`；SubagentDetail 导出保留为详情内容边界（SSR 单测直接渲染）；e2e helpers `collapseSubagentList` 退役（浮层不存在），subagent-interrupted 列表断言改经返回列表页，subagent-recovery-review 当前行已用时改详情顶栏；GLOSSARY「子代理」词条同步。ADR 0020 的 tab 体内部组织由本文取代，正文收纳右栏与消息流标记行的大结构维持不变。原型全量（三变体 + 切换机制 + 样例压测）留档 prototype/subagent-nav 分支。
