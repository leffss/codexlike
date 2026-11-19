# 01: Token 基座与全局排版（D 设计语言落地基座）

**What to build:** 应用换上「留白呼吸」的基调：全部语义 token（表面/内容/操作/状态/专属辅助/hl-*）在双主题块内按 ADR 0028 重定值——浅色取原型定案值，深色按暖灰逻辑新设计（非反转）；markdown 排版放宽（行高 1.7–1.75、段距 0.95em）；圆角 8–12px 与「阴影只给悬浮物」的全局纪律。落地后整个应用基调即刻变暖，深浅主题完整可切，后续各家族票在此基座上微调组件层。

**Blocked by:** None（can start immediately）

**Status:** done

- [x] styles.css 浅色块全部 token 换为原型 variant-d 值（暖白/暖灰/黑主张 accent/暖色状态系，见 notes.md「设计语言定案值」；原型源 `prototype/ui-modern` 分支 `variant-d.css`，剥作用域翻译）
- [x] 深色块按 D 暖灰逻辑全新设计（深暖灰底、同纪律层次），Monaco `--hl-*`/`vs-dark` 与 highlight.js 色可读性过关
- [x] markdown 排版参数放宽，长正文观感与原型一致
- [x] ui 单测全绿 + typecheck/build 过（不接管道取退出码）
- [x] theme e2e（主题切换/重启保持）实跑绿
- [x] 双主题 dev 走查截图留证（`?variant=d` 原型对照贴近）

## Comments

**2026-11-19 实施记录（票01）**

实施序列（TDD：产物断言红→绿）：

1. 基线：ui 单测 562 全绿；build 产物 grep 断言不含任何 D 定案值（红基线，证明断言有效）。
2. `packages/ui/src/styles.css`：浅色块全量换 variant-d 值（剥 `html[data-ui-variant="d"]` 作用域直译，原型第 0 节 token 全集）；深色块全新设计；markdown 排版放宽（p 段距 0.95em/行高 1.75、li 0.35em/1.7、pre padding 14px 18px）；`.markdown a` 改 `var(--info-fg)`（浅色即原型链接蓝 #2383e2，深色随 token 提亮）。
3. 阴影纪律物化：双主题各定义 `--shadow-popover/modal/toast/floating` 四档（浅色=原型弹层/模态/toast/浮钮四组定案值；深色加深到黑底可见），`@theme inline` 注册 + `@source inline(...)` 预注册候选（JIT 按源码扫描，预注册后下游动态拼类也可用），产物与浏览器 computedStyle 双验证。
4. 配套同步：`packages/desktop/src/main.ts` `WINDOW_BACKGROUND`（预加载窗口底色，契约即「与 --canvas 一致」）light #ffffff / dark #1f1e1c；`packages/desktop/e2e/theme.mjs` 深色 body 期望值 rgb(15,23,42)→rgb(31,30,28)（该断言硬编码旧 canvas，属 token 值镜像同步）。均非 .tsx 组件文件。
5. 绿验证：ui 单测 562 全绿（exit 0）、typecheck 0、build 0，产物含全部定案值（#f7f6f3/#37352f/#2f3437/#1f1e1c/#e8e6e1/0.95em→`.95em` 压缩形/四档 `.shadow-*` 规则）；desktop 单测 507 过 1 跳（exit 0）；desktop build 后 theme e2e 实跑绿（exit 0，含新深色期望值）。

深色套设计要点（无原型，按 D 暖灰逻辑新设计、非反转）：

- 基底冷蓝黑 → **暖深灰系**：canvas `#1f1e1c`、surface `#242322`、surface-muted `#2a2827`——「层次靠底色深浅」翻译为**次级面比主底亮一档**（浅色是暗一档，恒定明度差同一纪律）。
- 「accent 黑主张」深色语境翻为**亮白主张**：accent `#e8e6e1`（hover #ffffff）、on-accent 回主底暖深灰——按钮即白，与浅色按钮即黑对称。
- 状态/徽标/hl 色：保持浅色 Notion 色相，前景整体提亮一档（如 ok #448361→#6fb38c、danger #c4554d→#e58e85、info #2383e2→#62aeea），淡底改同色相 0.22–0.24 透明叠加；实心按钮保留色相微提亮（ok-solid #448361 原值，hover 提亮为深色惯例）。
- `--hl-*` 六 token 深色一套同色相提亮（keyword #e58f86 / string #75b98d / title #b395cd / number #6cb2f0）；Monaco 走内置 `vs-dark`（theme prop 随 useTheme，本票无涉）。
- 代码块 code-bg 与 surface-muted 同源 #2a2827（浅色同构关系保持）；内联码红棕提亮 #e8a29c。

留证说明：

- 双主题 dev 走查（vite 5175 端口，IAB 浏览器实测）：浅/深两主题全部 token computedStyle 逐项核验通过；markdown p 计算值 margin 13.3px/line-height 24.5px（0.95em/1.75）；四档阴影类 computedStyle 双主题核验通过。截图存 `.scratch/ui-modern/screenshots/01/`（light-workbench.png / dark-workbench.png）。
- 走查目视结论：浅色呈 Notion 式暖白留白观感（黑主张按钮、暖灰卡片块、无边框分隔确认）；深色层次与可读性成立。深色走查 AI 目视曾报「底色冷蓝黑/发送按钮橙色」——经 computedStyle 核实为误判：body rgb(31,30,28) 略暖，「橙色」实为 warn 语义提示条（token 正确）。
- 遗留给组件层的观察（非本票范围）：时间戳 text-fg-subtle（#75736e on #1f1e1c，约 3.4:1）属最弱信息定位、可用，票 04 如觉过弱可在组件层升档 fg-muted；输入卡/composer 内次级按钮仍有描边与 surface-muted 底（去边框化归票 03 组件层，本票不动 .tsx）。

给下游票（02-07）的衔接注意：

1. **弹层家族（票 06）**：阴影请直接用 `shadow-popover` / `shadow-toast`（浮钮用 `shadow-floating`）类或 `var(--shadow-popover)` 等变量，不要再手写 shadow-lg——四档已 `@source inline` 预注册，动态拼类可用；深色阴影已加深，勿在组件里覆写深色阴影值。模态卡用 `shadow-modal`。
2. **accent 语义**：accent 已是黑主张（深色=亮白主张），`bg-accent` 类的按钮即黑/即白；「激活/选中」类表达请用 `bg-surface-muted` + 字重或 `--selected`（暖灰），不要再引蓝色 accent。链接蓝只剩 `.markdown a`（var(--info-fg)），组件内链接样式勿用 accent。
3. **正文 15px**：原型 `.markdown` font-size 0.9375rem（15px）是 `message-assistant` 组件级规则，留给票 04；全局行高/段距本票已放宽，票 04 只需补字号与段间距（gap 24px/14px）。
4. **圆角体系**：Tailwind v4 默认 rounded-md=6px / rounded-lg=8px / rounded-xl=12px，恰合 8–12 体系（行/小钮 6、块 8、卡 10→rounded-[10px] 或 rounded-lg、模态 12），无需自定义 radius token。
5. **QueueBar 徽章缺口**（notes.md 已记）：`bg-accent-soft`/`text-accent-fg` 不存在类，票 04 按 D 语言补（如 ok 系或 fg-muted + surface-muted）。
6. theme e2e 深色断言已改 rgb(31,30,28)；desktop `WINDOW_BACKGROUND` 已同步新 canvas——后续票若改 `--canvas` 需三处同步（styles.css 两块 + main.ts）。
