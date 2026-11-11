# 语义色 token 与 data-theme 双主题，默认浅色

应用从「全组件硬编码 slate/sky 深色 Tailwind 色阶」迁移到 **CSS 语义变量 + `html[data-theme]` 切换**的双主题体系（light / dark，默认浅色，用户明确要求）。所有颜色决策集中到 `packages/ui/src/styles.css` 的两个主题块；组件只写语义 class（`bg-canvas` / `text-fg-muted` / `border-line` / `bg-ok-bg` …），经 Tailwind v4 `@theme inline` 映射为工具类。

## Considered Options

- **每个组件写 `dark:` 前缀双份色阶**：Tailwind 惯用做法，但 15+ 组件各自维护两套色值，新增颜色要逐处对齐，长期漂移不可控，弃。
- **renderer `localStorage` 作为唯一存储**：实现最小，但主进程读不到，Electron 窗口底色（`backgroundColor`，页面加载前穿透可见）无法随主题设置，深色用户每次重启闪浅色底，弃。
- **选定方案：主进程 JSON 为权威 + localStorage 镜像**：偏好落 `~/.codexlike/theme-settings.json`（照 terminal-settings 模式，`theme-settings-store` + IPC）；主进程启动时先读偏好再建窗口（底色 + `nativeTheme.themeSource` 同步），渲染端 index.html 内联脚本同步读 localStorage 镜像设 `data-theme` 防页内首帧闪烁，ThemeProvider 挂载后与主进程校准一次。

## Consequences

- 未配置时默认浅色（`:root` 即浅色，`data-theme` 缺省不需要属性）。
- highlight.js 不再全局 import `github-dark.css`（无法按主题切换）；token 色改为 styles.css 内 `--hl-*` 变量两套。Monaco diff 的 `theme` prop 随 `useTheme()` 动态切 `vs` / `vs-dark`。
- 新增颜色需求先在 styles.css 补语义变量（两主题各一份），组件不直接写色阶 class；这成为编码标准的一部分。
- 原生目录选择器、系统对话框等 OS 级 UI 的表现跟随 `nativeTheme`，与页面主题一致但不受 CSS 控制。
- 同步落地侧栏改版（参考图风格）：项目/会话层级缩进、弱化徽标与计数、右侧相对更新时间（`updatedAt`「最近更新」口径，`lib/relative-time`）——纯视觉/展示层变化，无行为变更。
