# ui-modern 实现票共享事实（探索沉淀，实现票以指针复用，勿重复探索）

来源：2026-11-19 原型轮（分支 `prototype/ui-modern`，ADR 0028 定案 D「留白呼吸」）。各票实现前读本文件 + spec.md + ADR 0028。

## 设计语言定案值（折回基线 = 原型 variant-d.css，剥 `html[data-ui-variant="d"]` 作用域后翻译）

- **暖色系**：canvas/surface 纯白；surface-muted `#f7f6f3`（Notion 暖灰，侧栏/输入卡底）；fg `#37352f`；fg-muted `#787774`；line `#ebeae8`（极淡，仅必要处）
- **accent 黑主张** `#2f3437`（按钮即黑）；链接蓝 `#2383e2` 降调仅 `.markdown a`；状态色（ok/warn/danger/info）与 worktree/subagent 徽标按暖色系重定（原型 variant-d.css 有全套值，深色套按暖灰逻辑新设计，非反转）
- **无边框纪律**：容器去边框去阴影；层次靠底色与间距；阴影白名单仅悬浮物（弹层/toast/浮钮/模态）
- **排版**：markdown 行高 1.7–1.75、段距 0.95em、正文 15px；轮间距 24px / 轮内 14px（五变体最大）；侧栏行高 ~34px
- **圆角**：8–12px（暖灰块 8 / 输入卡·计划卡·弹层 10 / 模态 12 / 行·小钮 6）
- **输入卡家族**（composer-card / new-task-composer / interaction-panel 三壳同形）：无边框 `#f7f6f3` 块 + 聚焦深色细描边淡入（白底上白光晕不可见，原型已验证用描边）
- **弹层家族**：纯白 + line 发丝线 + 双层柔和小阴影 + 10px 圆角；toast 中性 hairline（类别语义色保留）

## 组件 → 票分配（38 组件全覆盖，勿重勿漏）

- 票02 外壳：App.tsx(Header)/TaskSidebar/TitlebarTaskContext/WindowControls/TaskActivityBadge/TaskSearch(入口)
- 票03 输入面：MessageComposer/ComposerRegion/ComposerIcons/ComposerMenuList/NewTaskStart/InteractionPanel/InteractionHistory/WorkspaceModeSelector
- 票04 消息流：MessageStream/ToolCallCard/ToolDetailsBody/WorkPlanCard/SubagentStreamMarker/DisclosureArrow/QueueBar/TaskQueuedNotice/AssistantActions
- 票05 右栏：RailPanel/SubagentRailPanel/ResourceSnapshotSummary/MonacoDiff/GitActions
- 票06 弹层：ModelThinkingSelect/ComposerSelect/TaskContextMenu/FullAccessConfirmDialog/MembershipDialogs/ToastHost/ApplicationExit(冻结层)/TaskSearch(浮层)
- 票07 设置页：SettingsPage/McpSettingsSection/ProviderProfileForm

## 已知基线缺陷（票04 顺手修）

QueueBar「发送中/编辑中」徽章引用 `bg-accent-soft` / `text-accent-fg`——不存在的 Tailwind 类（基线即无样式）。原型 variant-e.css 就地修复过（直接覆盖），折回时按 D 语言补正确语义类或 styles.css 补 token。

## 检验与构建规矩（AGENTS.md 摘要 + 本轮事实）

- ui/desktop 的 `test` script 已前置 agent-core build；单测直接跑取退出码，**不接 `| tail` 类管道**（吞退出码假绿）
- e2e 在 desktop 包：`pnpm --filter @codexlike/desktop run test:e2e:<场景>`（场景名见 package.json scripts，全量 `test:e2e:all`）。开发目录模式加载 desktop `dist/main.cjs`——主进程源码改动后必须重建（launchTarget 有 mtime 新鲜度检查会直接失败，这是保护不是 bug）
- pre-commit 钩子跑全仓检查（eslint/adr/e2e-locator/三包全量测试，约 2–4 分钟），提交耐心等
- 提交纪律：每会话只提交本会话文件，显式路径逐个 `git add`
- 改 e2e 交互面（浮层/遮罩/面板结构/标记行定位）的票合入前实跑相关场景——单测绿不代表 e2e 可用（历史教训 335acb1）

## 关键定位钩子（优先 testid；全量 `grep -rn "data-testid" packages/ui/src`）

window-titlebar / composer-card / new-task-composer / new-task-start / interaction-panel / queue-bar / rail-panel / rail-tab-* / model-thinking-popover / task-context-menu / toast-region / subagent-stream-marker / plan-card / tool-call-* / back-to-latest / exit-confirm / exit-progress / full-access-confirm-dialog / membership-dialog / project-removal-dialog / task-search-input

## 双主题注意

- 主题机制：`html[data-theme]` 属性选择器双块（styles.css），Tailwind v4 会吞 `:root` 前缀变量块——新 token 必须放属性选择器块内
- Monaco diff theme prop 随 `useTheme()`（`vs`/`vs-dark`）；`--hl-*` 六 token 双主题各一套
- 深色套无原型：按 D 暖灰逻辑设计（深暖灰底、层次同纪律），实施完双主题 dev 走查截图对比
