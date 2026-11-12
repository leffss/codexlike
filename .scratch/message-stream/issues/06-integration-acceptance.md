# 06: 集成验收

**What to build:** 全部前置票合入后的整体验收:一次通过全量 e2e(既有 23 场景与本特性新增场景),spec 全部用户故事逐条映射验收记录,浅/深主题与宽/窄容器的视觉走查,两轴代码审查(/code-review:Standards + Spec)收尾并处理发现。本票不承担功能实现,也不替代各前置票自身的测试;它验证的是组合后的整体行为与规格符合度。[规格](../spec.md)全文为验收依据。

**Blocked by:** 01、02、03、04、05。

**Status:** completed

- [x] 全量 e2e 套件一次通过,命令与退出码如实记录(直接运行取退出码,不接管道)
- [x] spec 38 条用户故事逐条映射到验证方式与结果,记录入本票 Comments
- [x] 视觉走查:浅/深主题 × 宽/窄容器 × 空态/长会话,截图留档
- [x] 滚动跟随、思考恢复、折叠区、宽度四组新行为在同会话内组合无冲突
- [x] /code-review 两轴审查完成,发现项处理或记录豁免理由
- [x] 任务索引 README 更新各票状态
- [x] `pnpm typecheck`、`pnpm test`、`pnpm test:e2e:all` 全绿

## Comments

**集成验收记录(2026-11-12,集成分支 `feat/message-stream` tip `6ee8160`,worktree `ai-agent-worktrees/integration`)**

### 1. 全量检查(直接运行取退出码,输出重定向 `../acceptance/logs/` 留档;`*.log` 按仓库 gitignore 惯例不入库,关键证据行均已摘录在本节与走查记录中)

| 命令                | 退出码 | 备注                                                                   |
| ------------------- | ------ | ---------------------------------------------------------------------- |
| `pnpm install`      | 0      | Already up to date                                                     |
| `pnpm typecheck`    | 0      | agent-core build + 全仓 typecheck                                      |
| `pnpm test`         | 0      | 单测共 83 文件 700 例全绿:agent-core 46/418、desktop 20/125、ui 17/157 |
| `pnpm build`        | 0      | 全仓构建(容器查询 CSS 等产物生成正常)                                  |
| `pnpm test:e2e:all` | 0      | **29 场景一次通过,无复跑**                                             |

- 29 场景构成:原 23 + `message-order` / `worked-history` / `width-tiers` / `reasoning-recovery` / `scroll-following`(链上 29 个 `node e2e/*.mjs` 逐一核对)。
- **已知 flaky 复核口径**:本次全量一次通过,workbench-ipc 时序、projects-sidebar 建目录、interactions 端口偶撞、exit-recovery 写失败注入、sidebar hover 竞态**均未触发**,无「重跑后过」记录。日志中 `[main:err]` 行均为错误路径场景的预期注入噪声(compact 取消注入、worktree 非 git 目录场景等),非失败。

### 2. 视觉走查(`../acceptance/*.png`,脚本 `../acceptance/walkthrough.mjs`:playwright-core 启动生产产物 ui/dist + mock provider)

走查会话构成:轮 1「调研这些文件」= 思考→中间正文→read_file×3(第 3 个目标缺失→失败卡)→思考→最终正文(表格+代码块);轮 2「写一篇长文」= 思考+慢速长文,中途停止→中断轮;轮 3 = 纯正文短回复。脚本启动时把 localStorage 主题镜像归位浅色(Electron userData 不随 homeDir 隔离,e2e theme.mjs 同法),保证文件名主题标签与实际一致。

| 截图                                | 结论(一行)                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 01-light-wide-long-collapsed.png    | 浅色宽窗长会话收起态:轮次分组(细分隔线+轮间距)、「已工作」折叠区收起、用户气泡右对齐限宽、正文全宽含表格/代码 |
| 02-light-wide-long-expanded.png     | 浅色宽窗展开态:思考折叠块、中间正文、read_file×3 统计组、失败标记与耗时摘要完整呈现                           |
| 03-dark-wide-long-collapsed.png     | 深色宽窗收起态:主题 token 正确、无对比度回退、「回到最新」按钮可见                                            |
| 04-dark-wide-long-expanded.png      | 深色展开态:过程段完整(2 思考块+中间正文+组头计数「read_file × 3」+红色「含失败」标记),渲染正常                |
| 05-light-narrow-long-collapsed.png  | 浅色窄窗(1000)基础档:内容列回落全宽、无大片留白、折叠区收起                                                   |
| 06-dark-narrow-long-collapsed.png   | 深色窄窗基础档:同上布局,深色无异常                                                                            |
| 07-light-wide-interrupted-turn.png  | 中断轮强制展开:思考块可见、部分正文+「(已中断,以上为部分回复)」标记、折叠区展开箭头向下                       |
| 08-light-narrow-back-to-latest.png  | 窄窗脱离态:「回到最新」悬浮按钮可见于消息流右下                                                               |
| 09-dark-wide-back-to-latest.png     | 宽窗深色脱离态:按钮同样可见,位置一致                                                                          |
| 10-light-wide-empty.png             | 浅色宽窗空态:空态提示居中限宽列(2xl 档),与输入卡同宽对齐                                                      |
| 11-dark-wide-empty.png              | 深色宽窗空态:同上                                                                                             |
| 12-dark-narrow-empty.png            | 深色窄窗空态:空态列随容器回落                                                                                 |
| 13-light-narrow-empty.png           | 浅色窄窗空态:同上                                                                                             |
| 14-combo-wide-detached-expanded.png | 组合态:宽档+脱离(按钮在)+折叠区全展开三者并存无冲突                                                           |
| 15-combo-restored-position.png      | 切走切回后:像素阅读位置保持、手动展开态与思考恢复不丢                                                         |

### 3. 组合行为核查(同一长会话内,四组行为无相互干扰;证据 `../acceptance/logs/walkthrough-combo.log`)

覆盖方式:走查序列在同一 3 轮会话内连续执行 a-f 六步,每步 DOM 断言+记录实测值:

- a. 窄窗(1000)基础档:末段正文宽 663.2px(<800),滚动容器无横向溢出——**宽度分档**生效。
- b. wheel 上翻:scrollTop 归 0、距底 493px,back-to-latest 可见——**滚动跟随**脱离。
- c. 脱离态下展开全部折叠区:scrollTop 保持(Δ<4px)、仍脱离——**折叠区**展开不夺**跟随**滚动权。
- d. 放宽至 1600:末段正文宽 1071.2px(档位上移),仍脱离——**宽度**切换不干扰**跟随**态。
- e. 切走再切回:scrollTop 0→0(Δ<4px) 恢复,折叠区手动展开态保持,思考块不丢——**阅读位置记忆+思考恢复+折叠记忆**三者衔接。
- f. 点击回到最新:距底 1.6px(≤48)恢复跟随,按钮消失——**跟随**恢复闭环。

结论:滚动跟随、思考恢复、折叠区、宽度四组行为在同会话内组合无冲突。

### 4. spec 38 条用户故事逐条映射(验证方式 → 结果;单测文件:`packages/ui/tests/{scroll-follow,session-view,turn-view}.test.ts`)

**滚动跟随(1-9)**

1. ✅ e2e scroll-following 场景 1「流式输出期间自动贴底跟随」(distance≤48 且内容增长)+ 单测「跟随中贴底(snap)」
2. ✅ e2e scroll-following 场景 2 前半(wheel 上翻立即脱离)+ 单测「用户上翻(有向上意图)立即脱离跟随」
3. ✅ e2e 场景 2 后半(脱离期间 \|ΔscrollTop\|<4、内容增长不夺权)+ 单测「脱离时保持(hold,绝不拉回)」
4. ✅ e2e 场景 2/3(back-to-latest 出现→点击贴底→恢复后消失)+ 单测「可见 = 脱离跟随且有消息」+ 截图 08/09
5. ✅ 单测「用户下翻滚到底附近恢复跟随,未到底保持现状」+ 组合核查 f
6. ✅ e2e 场景 4「发送新消息强制回底并进入跟随」
7. ✅ 单测「程序化贴底与布局测高产生的滚动不动状态机」「无用户输入时布局回退不算上滚:保持跟随」
8. ✅ 单测「用户 wheel 上翻与流式内容 commit 同帧:贴底回弹落点不吞掉上翻」(纯输入重放)
9. ✅ 即时 scrollTop 赋值 + 禁用原生 scroll anchoring 已实现并验证;`scrollbar-gutter:stable` 按票 03 协调者裁决豁免(见票 03 Comments 裁决记录,本条按该口径映射)

**阅读位置记忆(10-12)**

10. ✅ e2e scroll-following 场景 5b(切回复像素位置 \|Δ\|<4px)+ persistent-workbench / exit-recovery 真实进程重启 <4px 断言
11. ✅ e2e scroll-following 场景 5a(贴底记忆→当前最新并跟随)+ 单测「贴底记忆恢复到当前最新并跟随,旧的像素位置作废」
12. ✅ 单测「无记忆定位当前最新并跟随(新会话)」「无溢出(内容不足一屏)恢复即跟随」

**时序保真(13-16)**

13. ✅ e2e message-order 场景 1b 严格 testid 序列 [thinking→正文→tool-call-card→thinking→正文](不靠文本过滤)
14. ✅ 同上 + 两段正文内容归属断言(工具后正文不含工具前文,反之亦然)
15. ✅ 同上(两段思考独立交错、不被归并顶部)+ 单测 session-view 交错保真(27 例)
16. ✅ e2e message-order / worked-history(message-turn 轮次分组断言)+ 截图 01-06(细分隔线+轮间距可见)

**已工作折叠区(17-21)**

17. ✅ e2e worked-history 场景 1 / message-order 场景 1(完成后序列只剩 [message-turn, message-user, worked-history, message-assistant])
18. ✅ e2e worked-history 场景 2(展开过程完整、可再收起)+ 截图 02/04
19. ✅ 单测 turn-view「运行中的轮强制展开(流态段/运行中工具卡/运行中子代理任一成立)」「宿主运行态把最后一轮视为运行中」+ e2e browser(工具运行中实时可见,票 04 偏差 3 的回归场景)
20. ✅ e2e worked-history 场景 3(中断轮 aria-expanded=true、思考可见)+ 单测「中断终态的轮强制展开」「错误终态的轮强制展开」+ 截图 07
21. ✅ e2e worked-history 场景 1(摘要行含「已工作」+ data-duration-ms)+ 截图 01-07 摘要行

**思考过程持久化(22-25)**

22. ✅ e2e reasoning-recovery 场景 4(重启后 thinking-block 展开回看)+ message-order 场景 3(重启恢复思考全文两段拼接)
23. ✅ e2e reasoning-recovery 场景 3(运行中切走再切回,思考唯一且完整、不重复不丢失)
24. ✅ e2e reasoning-recovery 场景 4(subagent-thinking-block 重启不空白、报告不被破坏)+ subagent-thinking 场景
25. ✅ e2e reasoning-recovery 场景 5(旧会话无思考数据:thinking-block 计 0,无空块)

**工具调用卡(26-30)**

26. ✅ e2e worked-history 场景 2(tool-call-duration 摘要耗时、data-tool-name)+ 截图 02/07(工具名+状态+耗时摘要行)
27. ✅ e2e message-order 场景 2 / worked-history 场景 2(展开分层见参数与输出内容)
28. ✅ e2e worked-history 场景 2(失败状态位「失败」+ title 详情可查)+ 单测「组头可判失败:组内含失败卡时带失败标记」+ 截图 07;运行中状态 e2e browser 实时可见
29. ✅ e2e worked-history 场景 2(read_file×3 统计组头 data-count=3、收起不渲染原卡、展开 3 张原卡)+ 单测连续性 4 例
30. ✅ e2e subagents(subagent-card data-subagent-state)+ reasoning-recovery 场景 1b/4(卡内思考折叠与最终报告、重启可回看);子代理卡为消息段按时序由 session-view/turn-view 单测覆盖

**宽度与布局(31-35)**

31. ✅ e2e width-tiers 场景 2/3(4xl 档突破 768 旧锁死、6xl 档上限 1152)+ 走查宽截图(末段正文实测 1071px>896)
32. ✅ e2e width-tiers 场景 2/3/5(三档边界全部以会话容器宽换算断言)+ 容器查询机制保证(右侧面板为容器内兄弟节点,开合不改变容器宽、不触发档位切换)
33. ✅ e2e width-tiers 场景 3(用户气泡限宽右对齐内容列右缘、assistant 全宽)+ 截图 01-08
34. ✅ e2e width-tiers 场景 4(宽表格/长代码自身容器内横向滚动、消息流 scrollWidth≤clientWidth)+ 组合核查 a(无横向溢出)
35. ✅ e2e width-tiers 场景 1/3(空态与输入卡同宽、头部/消息列/输入卡三处左右缘 ±1 对齐)+ 截图 10-13

**特殊项与兼容(36-38)**

36. ✅ e2e persistent-workbench(message-error 按时序)/ interrupt(「(已中断,以上为部分回复)」标记)/ compact(compact-summary 摘要段位置)+ 单测「交互/错误/状态段穿透折叠区(用户可见节点不进过程区)」
37. ✅ e2e compact(压缩后消息流只剩摘要+最近 3 轮、后续请求体含摘要与最近 3 轮不含被压轮次)
38. ✅ e2e persistent-workbench / exit-recovery(阅读位置 <4px 精度断言全绿未回归,重启/跨会话恢复精度不低于现状)

**映射统计:38/38 全部映射通过。**唯一豁免表述:第 9 条中 spec「滚动容器 scrollbar-gutter 稳定」按票 03 协调者裁决以「即时赋值+禁用原生 scroll anchoring 达成,gutter 豁免」口径映射(裁决理由与后续可选项见票 03 Comments)。

### 5. 状态收口与遗留

- 票 01-05 `**Status:**` 已改 `completed`,README 表格同步(01-05 completed,06 保持 ready-for-agent)。
- 验收项 5(/code-review 两轴审查)已于协调者执行两轴审查后收口:代码级发现(条件性 Hook、回到最新入口 boolean 反向转换、共享时长格式化、`resetCollapseMemory` 零调用者、根 package.json 缺 `test:e2e:worked-history` 单跑脚本)已修复并经 `pnpm typecheck`/`pnpm test`/`pnpm build`/`pnpm test:e2e:all` 复验全绿;豁免项记录见下节第 6 节。票 06 状态随之收口为 `completed`,README 表格同步。
- 无其他未决项:全量检查一次通过、38 条映射无失败、走查与组合核查无真实缺陷发现。

### 6. code-review 豁免记录(2026-11-12 补,两轴 /code-review 审查发现中"记录豁免理由"的部分;代码级发现已修复,见第 5 节)

**a. 重启恢复路径的轮内时序降级(Spec 轴唯一实质项)**

重启恢复(落盘重建)后的轮内呈现为落库终态形态:工具卡、拼接思考段、终稿正文单段,与流式期的段级交错(思考/正文/工具卡逐段穿插)不完全一致。这是 spec Implementation Decisions 第 6 条「reasoning 持久化:思考文本随终态消息落库」的固有结果——本 spec 未设计轮内段级落库,恢复路径只能从终态消息重建。判定为有据豁免而非缺陷:内容级完整(用户故事 22-25 全部达成,思考/工具/正文重启后均可回看);切回运行中会话(内存事件重放)时时序完整(用户故事 13-16 无此降级)。与 scrollbar-gutter(票 03 协调者裁决,见票 03 Comments)同为有据豁免。若未来要求重启后轮内段级时序保真,需升级为段级持久化(超出本 spec 范围)。

**b. e2e 新场景中 `getByRole("button", { name: "设置" / "返回工作台" })` 裸定位(Standards 轴,判断性意见)**

main 分支既有惯例的延续(smoke.mjs 同写法),目标按钮在场景内唯一且 name 精确匹配。记录在案,后续由 e2e 定位惯例统一收口,不在本票扩散。

**c. `session-view.ts` 各 event case 的 `seq/turnId/responseId` 构造样板(Data Clumps)与 e2e `xpath=..`/`.first()` 导航(Standards 轴,判断性意见)**

reducer 事件构造样板是显式直白成本,抽公共构造器会引入间接层;`xpath=..`/`.first()` 为既有 e2e 导航惯例。重构面大、收益一般,记录在案不动。
