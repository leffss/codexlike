# 集成验证记录

基线：cbc87fff9f879e27e01b5fa4c5c8cb2158cc2cd5。分支fix/code-audit-2026-11-18。原报告保持不变；问题修复状态以issues和本记录为准。

## 主代理公共接线

- 新增 `desktop/src/lifecycle/test-data-paths.ts`：显式CODEXLIKE_TEST_USER_DATA时在ready/实例锁之前配置独立userData及sessionData；正常用户启动不改变路径。
- `e2e/helpers.mjs` 为场景配置独立Electron数据，并在启动后核实实际路径；失败关闭该测试进程。packaged场景把Electron路径放业务home的兄弟目录，保持“业务父目录不存在”断言有效。
- `main.ts` 给exit模块注入trayResidency.showMainWindow，复用恢复/聚焦/pendingMaximize。
- 相关E2E新增行为：changes同路径内容变化后刷新、input-queue-items编辑绕行新建/设置、exit从隐藏窗口直接quit、subagent-recovery完整工具详情及compact后仍检视；subagent-interrupted/work-plan适配两级lazy展开。

## 已运行

- `pnpm --filter @codexlike/desktop exec vitest run tests/lifecycle/test-data-paths.test.ts`：先红（模块尚未实现，exit1），实现后3/3通过(exit0)。
- 主代理上述独占TS/mjs文件prettier check/write：通过。
- 修改的E2E `node --check`：通过。
- `pnpm check:e2e-locators`：通过，44场景另豁免6。
- `pnpm --filter @codexlike/desktop exec tsc --noEmit -p tsconfig.json`：当前宿主类型检查通过(exit0)。
- 隔离路径+close-to-tray+tray-residency 定向集成：3文件22测试通过(exit0)。
- 主代理main/test-data-paths ESLint与独占E2E/TS格式检查通过。
- 已只读确认现有 Chromium 1254 和 chromium_headless_shell 1254 可执行文件，最终真实本地浏览器单测可使用缓存，无需下载。
- 构建产物加载+隔离路径复跑：2文件7测试通过(exit0)。
- 阶段性UI typecheck曾exit1：新增Settings测试把Playwright的exact选项用于testing-library ByRoleOptions；已交06修复，待最终全仓复验。
- 主代理独立复跑调度/存储8文件组合：92 passed / 1 skipped，exit0；覆盖F01/F05/F06/F07/F10/F11/F12/F17。唯一skip为显式标记的文件symlink权限限制。
- Core冻结后统一build exit0，desktop tsc对最新Core通过。
- 首轮desktop全测exit1：54文件444pass/1skip，唯一失败为review新增且进行中的构建测试DEBUG_FILE sentinel（在隔离临时文件中复现被截断），其余新Core/宿主组合通过。02已修该测试隔离边界，待最终全仓重跑。
- 首轮Core全测exit1：580pass/2fail，一条mcp-task测试仍把宿主ID当provider ID，主代理改为按tool-call事件的实际宿主ID关联；另一条既有worktree parallel场景在全并发下5000ms超时。两文件定向重跑10/10 exit0，worktree两项约3秒，未修改超时或产品逻辑。
- 第二轮Core全测仍仅worktree超时；单变量 `--maxWorkers=4` 全52文件582测试通过(exit0)，同一worktree约3.3秒。根因为真实进程测试的全并发资源争用，新增Core vitest.config.ts限制4 workers，保留原超时/断言；默认命令最终还需复验。
- 首轮全仓typecheck/lint/ADR/定位器检查exit0；UI全53文件538测试通过(exit0)。
- 真实隔离Electron input-queue-items通过(exit0)，含新增A→新建→A与设置往返原草稿保留。
- changes、persistence、scroll三场景串行通过(exit0)：同路径diff新内容、窗口参数保留/主动清空、真实重启/草稿/阅读位置、节流后跟随与脱离均通过。
- subagent-recovery通过(exit0)：正常重启完整工具详情、3轮后compact裁首轮仍能检视报告/已展开output。随后subagent-interrupted失败(exit1)：独立全新userData强杀重启后safeStorage.decryptStringAsync无法解密Profile，后续work-plan/legacy未运行。正在诊断，不按UI断言失败误判恢复修复，也不删除配置或改明文。

## 性能对照（已运行）

`node --expose-gc .scratch/code-audit-2026-11-18/benchmarks/mentions.mjs` exit0：128MiB相同规模日志，修复后每轮实际读取131,073字节，三次同步耗时2.168/1.602/1.662ms；审计前每轮读取134,217,728字节、约79–84ms。字节量减少约1024倍，返回131,094字符保持一致。时间受机器缓存影响，核心验收是有界IO和Buffer，而非固定毫秒。

`pnpm --filter @codexlike/ui exec vitest run tests/message-rendering-ui.test.tsx` 主代理独立复跑 exit0、7/7：5/100历史的tick和无关父更新解析均为0，活动delta为1、未变历史解析0；原100历史每次101次。终态全文、lazy和晚commit/切换清理回归同文件通过。

## 最终验证清单

- [x] Core所有者代码稳定后统一build；R1/R2与F08悬空链接补漏后再次三包build通过，产物新鲜度守门生效。
- [x] 默认 `pnpm build && pnpm test` exit0：Core52文件587pass；desktop55文件445pass/1skip；UI53文件538pass，总160文件1570pass/1skip。包括R1/R2和F08复审补漏。随后typecheck/lint/check:adr/check:e2e-locators及git diff --check均exit0。
- [x] 隔离E2E 8项：task-queue-restart、input-queue、input-queue-pause、input-queue-restart、input-queue-items、compact、exit、commands，全通过。
- [x] 呈现E2E 11项：changes、persistence、scroll、thinking、subagents、subagent-thinking、subagent-recovery、subagent-interrupted、subagent-work-plan、subagent-legacy、reasoning-recovery，全通过。先前基于旧Core产物跑过的5项已在最终构建重新复跑通过；共19个相关场景。
- [x] 固定数据集性能对照：历史Markdown解析工作量、mentions预算有上述主代理实跑；read_file预算/UTF8/abort回归随最终Core全测通过。
- [x] Standards/Spec独立复审与修复复验：原reviewers分别确认DEBUG_FILE隔离、R1/R2、F08及F04 E2E适配均可关闭；Standards硬违反0、非阻塞建议2。原26项范围无待处理阻塞项，新票08单独披露。

### 新发现边界（未修复）

独立全新用户目录首次safeStorage加密后立即强杀，Electron密钥可能尚未提交至Local State，重启无法解密。无窗口最小探针确认产品默认目录布局也存在，DOMStorage/cookie flush和同步加密均不能修。见 `issues/08-electron-first-key-durability.md`，明确未计入原26项已修复结论。

subagent-interrupted场景现显式以“已完成首次配置”的用户为前提：先正常退出并验证跨进程解密，再执行真正强杀任务恢复；该修复后场景通过，不代表首启密钥耐久性问题已修。没有改明文、删除配置、复制真实用户密钥或用sleep假装修复。

### 非阻塞警告

最终lint为0 errors / 8 Fast Refresh warnings（原6条，本轮Markdown模块混合导出新增2条）；未屏蔽warning。构建仍有依赖Zod注释与Vite大chunk告警，无empty-import-meta。真实GPU/debugger退出日志部分场景出现但断言与进程退出均通过。

E2E先build检查新鲜度；显式清空CODEXLIKE_PACKAGED_EXE，所有假模型监听本地。测试可能短暂显示/聚焦临时Electron窗口；不执行window-controls原生鼠标、不跑message-order/process-segments系统剪贴板、不下载Chromium。子代理工具生命周期测试使用fake浏览器或预装本地边界，不取用户凭据。
