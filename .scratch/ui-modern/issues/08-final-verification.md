# 08: 收尾——全量验证、一致性走查与收档

**What to build:** 全部家族票合入后的收口：全量 e2e 实跑修余留；跨界面视觉一致性走查（圆角 8–12px 体系、间距档位、阴影白名单执行、暖色一致性、深色套完整性）；确认无功能丢失与无残留旧风格；关单勾验收；原型分支处置确认。

**Blocked by:** 02, 03, 04, 05, 06, 07（全部家族票）

**Status:** done

- [x] `test:e2e:all` 全量 40 场景实跑绿（desktop 需先重建 dist）
- [x] 三包单测全量绿
- [x] 视觉一致性走查：圆角/间距/阴影白名单/双主题逐面截图核对，不一致处修复
- [x] dev 预览三态（任务/审批/问答/新建起点）+ 设置页 + 弹层全家最终截图留证
- [x] 各票验收 checkbox 逐条勾选关单
- [x] 原型分支 `prototype/ui-modern` 保留确认（存档不删）；`docs/agents` 无需更新项确认
- [x] 总结落 spec.md Comments（实施序列、残留清单及允许理由）

## Comments

**2026-11-19 实施记录（票08 收尾）**

**跨票议题裁决与执行（编排者收集的五项）：**

1. **输入聚焦语汇统一（必修，已执行）**：裁决为「描边淡入是唯一聚焦机制」——03 三壳的 focus-within color-mix 描边+外晕是原型正源（不动）；05 GitActions textarea 与 06 TaskSearch 浮层输入的 `focus:border-accent`、07 表单 21 处的 `focus:ring-[1.5px] focus:ring-fg/50`、03 InteractionPanel 自定义输入的 arbitrary 类共 24 处，统一为 **`focus:input-focus-ring` 语义类**（styles.css `@utility` 注册：`box-shadow: 0 0 0 1.5px color-mix(in oklab, var(--fg) 45%, transparent)` + `transition-shadow duration-150`）——与壳描边同 color-mix 家族、双主题随 --fg 自动换向。实测（vite dev + 真实点击）：GitActions textarea 与设置页输入深色下均 `oklab(0.919…/0.45) 0px 0px 0px 1.5px`（= --fg #e6e4df 45%）。
   - **为什么用 @utility 而非 arbitrary 类**：实施中发现 `@tailwindcss/vite` dev 扫描器不提取 `focus:shadow-[0_0_0_1.5px_color-mix(…)]` 形态的任意值候选（build 产物三条规则齐全、dev 一条不生成；票 03 时代 InteractionPanel 同串类在 dev 即缺失，走查未覆盖故未暴露）；`@source inline` 预注册走同一提取器同样无效。@utility 语义类 dev/build 双通道确定性生成，且更符合「组件只写语义 class」纪律。教训沉淀：arbitrary 值含 1.5px+color-mix 组合时勿依赖扫描提取。
   - 走查方法论沉淀：浏览器窗口失焦时 `:focus` 伪类不匹配（document.hasFocus()=false）——computedStyle 聚焦态验证必须真实点击激活窗口，el.focus() + 读值会得到 none 假象（本次排障的主要弯路）。
2. **task-auto-approve 提示卡（必修，已执行）**：WorkspacePage 内嵌卡去 `border border-warn-fg/40` 描边 → `rounded-lg bg-warn-bg` warn 淡底块（D 语言「语义色靠底色」）；卡内「取消自动批准」钮去 `border border-line` → `rounded-md hover:bg-hover`。浅色目视实证：无边框淡黄圆角块、与三键淡底同语言。
3. **深色时间戳对比度（裁决：保留）**：深色 fg-subtle on 暖灰卡实测 3.10:1，**优于浅色定案同级 2.9:1**（#9f9e9b on #f7f6f3，原型正源值）；「时间戳=最弱信息定位」的层级纪律是 D 定案观感的一部分，单侧升档 fg-muted 会破坏深浅对称（浅色正源不能动），故保留。AI 目视深色走查结论「基本可读」支持。
4. **关闭钮 hover 暖灰（复核：保留）**：实机 hover 实测 rgba(237,233,223,0.06)（深色暖白 6%），与最小化/最大化及全部标题栏按钮同语汇；「关闭=危险」由 ✕ 图标表达，D 语言「chrome 感最低」优先，保留票 02 的严格解释。
5. **07 行操作小钮深色可读性（复核：保留）**：text-fg-muted 深色 #a09e99 on #2a2827 理论约 5.6:1，实机目视「对比度尚可、清晰可读」——不弱，保留票 07 的裸文字+hover 决定（「删除无危险色」为票 07 有意取舍，非可读性问题）。
6. 幽灵项确认：03 Comments 的「QueueBar 归 04」与 05 Comments 的「resources-toggle 旧描边」均为基线分叉期过时信息（04 已修、02 已改），未追。
7. sidebar-archive e2e：首轮全量跑红 1 次「取消置顶恢复最近发送顺序」（票 02 已记录的时序型 flake，纯 DOM 顺序断言与样式无关），单跑复验绿（exit 0）；rowHeight 34 恰压线过（票 02 预警项，未再动侧栏行高）。

**theme e2e 断言镜像同步（本轮新发现）**：全量首跑暴露 `theme.mjs` assertComposerSurface 的旧基线断言「输入卡片自身边框应保留」（`cardBorder > 0`）——票 03 三壳去边框后过时，票 03/06 各自 e2e 清单不含 theme 场景故未暴露，全量首跑才见。按票 01 同类先例（token 值镜像同步）改为「无边框暖灰块」断言（`cardBorder === 0 && cardBackground !== streamBackground`，主题翻转靠底色换向），theme 单场景实跑绿。

**全量检验结果（直接取退出码）：**

- 三包单测：agent-core 587 passed（52 files）exit 0；desktop 507 passed + 1 skipped（58 files）exit 0；ui 591 passed（57 files，含 settings-d-language 断言随 `focus:input-focus-ring` 同步）exit 0。
- ui build/typecheck 0；产物核验：CSS 含 `.focus\:input-focus-ring:focus{box-shadow:0 0 0 1.5px var(--fg)}` + color-mix 增强版两条，JS 23 处消费；`focus:border-accent`/`focus:ring-[1.5px]`/`focus:shadow-[0_0_0_1.5px` 旧串产物 0 残留。
- `test:e2e:all` 全量 40 场景第三轮实跑绿（前两轮教训见上 7 与 theme 同步段；desktop dist + ui dist 均为本轮改动后重建，40 场景同一产物）。

**视觉一致性走查（vite 5182 双主题，11 张截图存 `.scratch/ui-modern/screenshots/08/`）：**

- light/dark × 工作台（含消息流/计划卡/工具卡/auto-approve 卡/输入区）、dark × 新建起点、dark × 右栏三 tab（changes/resources/subagents）、dark × 设置页整页 + 聚焦态、light × 设置页、dark × 模型弹层。
- 体系核对：弹层 10px 圆角 + surface 底 + line 发丝线 + shadow-popover（computedStyle 实证 #242322/#383634/10px）；暖灰块 rounded-lg 8px；模态 12px（票 06 实证）；行/小钮 6px。阴影仅弹层/浮钮/toast/模态（走查面无多余阴影）。暖色一致性：浅色暖白暖灰成立；深色暖深灰成立（AI 目视一处「偏冷」评论与票 01/02 的目视误判同类，computedStyle #1f1e1c/#242322 为暖灰系，机器值为准）。
- 截图目视复核已知观察项（均不构成修复项）：深色主底与次级面明度差含蓄（D「亮一档」纪律固有，激活表达有三通道）、起点页标题层级偏弱（信息架构冻结不动）。

**收档记录：**

- 票 01-07 验收 checkbox 逐条核对全部已勾，Status 全部置 done；票 08 同步关单。
- `prototype/ui-modern` 分支确认保留（worktree `git branch` 可见，未删）。
- `docs/agents/`（domain.md / issue-tracker.md / triage-labels.md）无 ui-modern 相关内容，无需更新。
- spec.md 末尾追加实施总结 Comments。

**给 code-review 的注意点：**

1. styles.css 新增 `@utility input-focus-ring`（票 01 token 基座文件的跨票协调改动，机制见 Comments 1）。
2. theme.mjs 断言改动是样式值镜像同步（意图不变：主题翻转下 composer 外观正确），非行为断言改写。
3. settings-d-language.test.tsx 六处 `focus:ring` 断言随语义类同步（意图不变）。
4. GitActions/TaskSearch/SettingsPage/McpSettingsSection/ProviderProfileForm/InteractionPanel 六文件的聚焦类替换均为纯 className 级（24 处），testid/行为零改动。
