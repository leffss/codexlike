# 05: 容器分档宽度

**What to build:** 消息流内容列抛弃 768px 一刀切,改为以会话容器(非浏览器视口)为断点的三档:空态 max-w-2xl;容器 ≥864px 收窄留白且上限 max-w-4xl;≥1280px 上限 max-w-6xl。消息流、头部与输入区共用同一内容列宽度类保证对齐;用户消息限宽右对齐气泡,assistant 正文与工具卡全宽;代码块与表格横向滚动内聚在自身容器,滚动容器无横向溢出。完成后宽屏下代码块、diff、表格获得最多 1152px 空间,侧栏开合不引起内容列跳宽——"消息显示宽度不够"的修复。[规格](../spec.md)宽度与布局组用户故事;分档依据见 [ZCode 调研报告](../../../../docs/research/zcode-message-stream.md)第三节。

**Blocked by:** 无(纯布局层,可与 01 并行;两票同触消息流组件,合并时注意先后)。

**Status:** completed

- [x] 内容列三档宽度生效:空态 2xl / 容器 ≥864px 上限 4xl / ≥1280px 上限 6xl,断点以会话容器为基准
- [x] 消息流、头部、输入区共用同一内容列宽度类,左右缘对齐;宽度变化无过渡动画
- [x] 用户消息限宽右对齐气泡;assistant 正文与工具卡占满内容列
- [x] 宽代码块与表格在自身容器内横向滚动,消息流滚动容器自身无横向溢出
- [x] 侧栏开合、窗口缩放不引起内容列宽度跳变
- [x] 新增 e2e 宽度断言:assistant 内容实际渲染宽度突破 768px 锁死值
- [x] 浅色/深色主题下视觉走查通过(对齐主题 token,无对比度回退)

## Comments

**实施提交:** `ff61513`(`feat(message-stream): 容器分档宽度——内容列三档、共用对齐与内聚横向滚动`,分支 `feat/message-stream-05`,基于集成分支 `feat/message-stream@8f05cc4`,完成后 merge 集成分支为 no-op)。票文件勾选另见后续 docs 提交。

**实现方式:**

- 宽度类集中在 `packages/ui/src/lib/content-width.ts`(`SESSION_CONTENT_WIDTH_CLASS` / `SESSION_EMPTY_WIDTH_CLASS`),WorkspacePage 单点选档(空态=消息流为空且未在压缩)下发给头部、MessageStream、MessageComposer;三处水平 padding 统一 `px-4`。
- Tailwind v4 容器查询:中栏 section 标记 `@container/session`,变体 `@min-[864px]/session:` / `@min-[1280px]/session:`;产物 CSS 已核对(`width: calc(100% - 6rem)` + `max-width: var(--container-4xl)` 等,1280 档生成顺序在 864 档之后,覆盖正确)。
- 断点基准为会话容器:右侧「规范与技能 / 改动」面板是容器内兄弟节点,开合不改变容器宽度、不触发档位切换;侧栏开合/窗口缩放只引起档位内的连续变化或一次性分档切换,无过渡动画。
- 用户气泡 `max-w-[min(85%,36rem)]`(相对限宽保护窄容器,绝对上限防宽内容列下行长失控);assistant 正文/工具卡/子代理卡全宽;消息流滚动容器 `overflow-x-hidden`。
- markdown 表格经 `packages/ui/src/lib/markdown.tsx`(`components.table` 包 `overflow-x-auto` 容器)内聚滚动,接入 assistant 正文、compact 摘要、子代理报告三处 ReactMarkdown;代码块沿用 styles.css `pre { overflow-x: auto }`。

**测试命令与真实退出码(worktree 内):**

- `pnpm typecheck` → 0
- `pnpm test`(46+20+15 文件,416+125+104 用例)→ 0
- `pnpm build` → 0(容器查询 CSS 生成已人工核对)
- `pnpm test:e2e:all`(现有 23 场景 + 新增 width-tiers,共 24)→ 0
- 新场景单独跑法:`pnpm test:e2e:width`(根脚本,含 build);已同时接入 `test:e2e:all` 链尾。

**e2e 新场景 `packages/desktop/e2e/width-tiers.mjs` 断言:** 空态 2xl(≤672)且与输入卡同宽;4xl 档(窗口内容区 1280→容器 1024)assistant 宽 896、突破 768 旧锁死;6xl 档(1600→容器 1344)宽 1100–1153 且头部/消息列/输入卡三处 x/宽度 ±1 对齐、用户气泡限宽右对齐内容列右缘;宽表格(不可断 token 撑宽)与长代码行自身容器内横向滚动、消息流 scrollWidth ≤ clientWidth;基础档(1000→容器 744)回落全宽 712。

**主题走查:** 改动仅布局/宽度类,零颜色变更;临时脚本实测浅/深两主题下 body 背景、assistant 卡片背景/边框、pre 背景、表头背景、用户气泡背景、头部底边框 7 处关键色全部命中语义 token(`--canvas/--surface/--line/--code-bg/--surface-muted/--selected`),与 ADR 0006 token 体系一致,无对比度回退;另有 DOM 几何复核:五处内容列容器 x=368 w=1120 完全一致。

**偏差与遗留:**

- 表格 e2e 断言用不可断 token(`"X".repeat(30)`)撑宽:可折行文本(中文/带空格)会在单元格内换行使表格收缩到容器宽,触发不了横向滚动——这是 markdown 表格的预期排版行为,不是缺陷。
- 本机窗口 1600 请求被系统 workarea 夹到实际内容区 1568(容器 1312),6xl 档内容列实测 1120(<1152 上限,仍在断言区间内);档位判定不受影响。
- 与票 01 的接触面:MessageStream.tsx(props 新增 `contentWidthClass`、ol/空态容器类、用户气泡类、markdown components 注入)、MessageComposer.tsx(props + form 类)、SubagentCard.tsx(markdown components 注入)、WorkspacePage.tsx(section 容器标记 + header wrapper + 单点选档)——均为布局层,未触碰 UiItem 数据模型与渲染分派逻辑。
- 走查截图未留档(临时目录);如需人工目检可重跑 `pnpm test:e2e:width`。
