# 01: Token 基座与全局排版（D 设计语言落地基座）

**What to build:** 应用换上「留白呼吸」的基调：全部语义 token（表面/内容/操作/状态/专属辅助/hl-*）在双主题块内按 ADR 0028 重定值——浅色取原型定案值，深色按暖灰逻辑新设计（非反转）；markdown 排版放宽（行高 1.7–1.75、段距 0.95em）；圆角 8–12px 与「阴影只给悬浮物」的全局纪律。落地后整个应用基调即刻变暖，深浅主题完整可切，后续各家族票在此基座上微调组件层。

**Blocked by:** None（can start immediately）

**Status:** ready-for-agent

- [ ] styles.css 浅色块全部 token 换为原型 variant-d 值（暖白/暖灰/黑主张 accent/暖色状态系，见 notes.md「设计语言定案值」；原型源 `prototype/ui-modern` 分支 `variant-d.css`，剥作用域翻译）
- [ ] 深色块按 D 暖灰逻辑全新设计（深暖灰底、同纪律层次），Monaco `--hl-*`/`vs-dark` 与 highlight.js 色可读性过关
- [ ] markdown 排版参数放宽，长正文观感与原型一致
- [ ] ui 单测全绿 + typecheck/build 过（不接管道取退出码）
- [ ] theme e2e（主题切换/重启保持）实跑绿
- [ ] 双主题 dev 走查截图留证（`?variant=d` 原型对照贴近）

## Comments
