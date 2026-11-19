# 06: 弹层家族——选择器 / 右键菜单 / 确认框 / toast / 退出冻结层

**What to build:** 全部弹层统一 D 语汇（白卡+发丝线+双层柔和小阴影+10px 圆角，阴影白名单成员）：模型与思考档位选择器、通用下拉、composer 补全菜单（/命令·@文件·$技能）、侧栏右键菜单、任务搜索浮层、完全访问确认对话框、任务归属/项目移除对话框、退出确认与进度冻结层、toast 通知（中性 hairline，类别语义色保留）。弹层定位/开合/键盘导航行为完全不变。

**Blocked by:** 01（token 基座）

**Status:** ready-for-agent

- [x] model-thinking-popover 白卡化；portal 弹层从 html 继承 token（基座票已保证），几何锁定（use-stable-popover）行为不变
- [x] 右键菜单/composer 菜单/任务搜索浮层白卡统一；选中/hover 态暖灰
- [x] 确认对话框全家（full-access/membership/project-removal/exit-confirm/exit-progress）白卡 12px 圆角柔投影
- [x] toast hairline 白卡、五类通知语义色保留可辨
- [x] 弹层键盘导航（aria-activedescendant 等）行为不变
- [x] ui 单测全绿
- [x] e2e 实跑绿：thinking / membership / exit-recovery / task-search / approvals（full-access 对话框路径）
- [x] dev 双主题走查截图留证

## Comments

**2026-11-19 实施记录（票06）**

实施序列（TDD：渲染类名断言红→绿）：

1. 基线：新增 `packages/ui/tests/popover-family-ui.test.tsx`（10 断言：8 组件语汇 + 2 转办弹层），红基线确认（8 failed，全部缺新语汇类、220px 宽度锚在）。
2. 主体八组件类名折回（零行为改动，定位/开合/键盘导航/testid 全不动）：
   - 弹层档（10px 圆角 + `shadow-popover` + line 发丝线 + bg-surface 白卡）：model-thinking-popover（`w-[220px]` 宽度纪律保持，thinking e2e 宽度上限断言过）、ComposerSelect listbox、task-context-menu、TaskSearch 浮层。
   - 模态档（12px=rounded-xl + `shadow-modal`，无边框）：full-access-confirm、membership-dialog、project-removal-dialog、ApplicationExit 冻结层与 exit-error 角标（原型将 exit-error 归入模态卡规则）。full-access 的警示语义保留在标题/正文文字色，弃警示色描边。
   - toast 档（10px + `shadow-toast` + 中性 `border-line` 发丝线）：KIND_CLASS 边框类别色→中性，底色/文字/圆点类别语义保留（原型注释「类别色留在底色 token」）；toast-host-ui 原断言（bg-warn-bg/bg-danger-bg/bg-surface）不动全绿。
   - TaskSearch 浮层内输入框顺带 D 纪律：平时 `border-transparent` + `bg-surface-muted`，聚焦 `focus:border-accent`（黑主张描边，与原型「聚焦深色细描边」同向）。
3. **票 02 转办增量**（编排者中途指派）：TitlebarTaskContext 的 WorkspaceBadgePopover（workspace-popover）与 workspace-opener-menu 两个漏网弹层同语汇白卡化（先 `git merge ui-modern` 带入票 02，TaskSearch.tsx 自动合并无冲突）；徽章/开关按钮未动（票 02 地盘）。
4. 绿验证（直接取退出码）：ui 单测 572 全绿（562 基线 + 10 新增，exit 0）；typecheck 0；build 0；产物 grep：`.shadow-popover/.shadow-modal/.shadow-toast` 类规则 + `rounded-\[10px\]{border-radius:10px}` 均在，9 组件源码零 shadow-lg/shadow-xl 残留。
5. e2e 实跑六场景全绿（均 exit 0；desktop build 前置）：thinking（含 popover 宽度上限断言）/ membership / exit-recovery / task-search / approvals（full-access 对话框路径）/ workspace-opener（转办增量补跑）。

dev 双主题走查（vite 5180，IAB 实测 + computedStyle 逐项核验）：

- 浅色：model popover（bg #fff / border #ebeae8 / 10px / 双层影 2px 6px 5% + 10px 28px 10%）、composer listbox、右键菜单、徽章弹层、opener 菜单、membership 对话框（12px + 0 8px 32px 18% 无边框）、toast（10px + 0 4px 14px 8% + danger 底 #fbe5e1）全过；深色（portal 从 html 继承 token）：popover bg #242322 / border #383634 / 深色阴影 0.3+0.45、toast danger-bg 同色相 0.22 叠加 + 深色 shadow-toast 0.4、模态 12px + 0 8px 32px 0.55 全过。
- toast 触发路径：临时在 dev browser-stub `openers.open` 注入抛错（走查后已还原、不入提交），点「打开工作区」→ notifyError → error toast 实拍。
- 截图 11 张存 `.scratch/ui-modern/screenshots/06/`：浅色 7（model-popover / composer-select / context-menu / membership-dialog / toast / workspace-popover / opener-menu）+ 深色 4（model-popover / context-menu / toast / membership-dialog）。

给下游（票 08 收尾 / 后续微调）的衔接注意：

1. 弹层家族现已全员消费四档阴影 token（popover/modal/toast/floating 中前三档），代码里不再有手写阴影；票 04 的「回到底部」浮钮用 `shadow-floating`（notes.md 已记）。
2. WorkspacePage 消息流内嵌的「已开启自动批准」提示卡（task-auto-approve testid，border-warn-fg/40 旧语汇）是页面内嵌卡非浮层，走查时确认仍为旧样式——归票 04 消息流管辖，本票未动。
3. MembershipDialogs / FullAccessConfirmDialog 内的按钮（border-line 描边次级钮）保持原样——按钮家族统一不在本票边界。
