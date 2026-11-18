# 审计修复交付

## 结果

原审计 **F01–F26 全部完成修复**；C01 已按异步边界补防御性守卫与回归，C02 经真实 Task/SQLite 确认后修复。独立复审发现的测试隔离、abort/持久化故障、悬空链接及lazy测试适配漏项均已修复，并由原审查者确认关闭。

**另外发现一个未修问题**：Electron 首次加密密钥延迟持久化窗口，详见下方“新发现”。因此“原审计项已完成”不等于整个项目没有剩余缺陷。

- 基线：`cbc87fff9f879e27e01b5fa4c5c8cb2158cc2cd5`
- 分支：`fix/code-audit-2026-11-18`
- 状态：代码和测试保留为未提交改动，未 commit/push；未改用户原有 LICENSE/.zcode 内容。
- 详细记录：[原始报告](REPORT.md)、[批准规格](spec.md)、[集成检查与失败记录](INTEGRATION.md)、[独立复审](REVIEW.md)。

## 修复核销

| ID  | 修复结果                                                        | 主要验证接缝                                      |
| --- | --------------------------------------------------------------- | ------------------------------------------------- |
| F01 | 排队准备阶段可撤销，停止后不启动、首条不重复                    | 真实IPC+SQLite+本地SSE闸门                        |
| F02 | CJS运行时提供正确模块URL，冷缓存到达合法CLI                     | 真实dev/prod配置内存产物与安装器                  |
| F03 | dev/prod共享external依赖边界，不内联Playwright                  | 真实入口main/preload加载                          |
| F04 | 独立计时、Markdown memo叶、lazy详情、75ms显示节流/终态即时      | jsdom解析计数+真实滚动/thinking E2E               |
| F05 | thaw推进两个队列，pump合并重入且不自旋                          | 真退出状态机+队列IPC                              |
| F06 | queued首次请求也属于已接受意图，重复返回原任务                  | 真SQLite重开/消费故障补偿                         |
| F07 | Compact满员明确拒绝，终态释放名额                               | IPC跨任务准入与结束/失败/中断                     |
| F08 | 重复真实目标整批拒绝，未解析symlink同样预检拒绝                 | 真文件/junction/hardlink与文件symlink边界夹具     |
| F09 | 队列编辑仅借用内存composer，原草稿持久；导航/退出正确收尾       | 真实Workspace/ApplicationExit+新建/设置E2E        |
| F10 | 排他临时文件写完后替换，失败保留旧JSON                          | store公开API+部分写/替换故障                      |
| F11 | 加密后同步重读提交，不复活删除、不覆盖新建                      | 控制加密完成时序的真实store                       |
| F12 | 退出确认/错误显示恢复聚焦窗口，复用托盘控制器                   | 模块边界+隐藏直接quit真实E2E                      |
| F13 | MCP共享在途连接并按代次关闭，旧工具不复活                       | 本地stdio并发/PID回收                             |
| F14 | 同任务共享页面创建，失败/close/reset均清理                      | Playwright生命周期边界fake+既有真实本地浏览器单测 |
| F15 | 仅cmd采用专门引号/verbatim策略                                  | Windows真命令/空格路径/元字符                     |
| F16 | read_file输出128KiB、扫描8MiB、分块64KiB，提前停与UTF8/abort    | 实际IO计量及Tool.execute                          |
| F17 | @引用只读128KiB+1字节探测，不全量分配                           | 真文件预算回归+128MiB性能对照                     |
| F18 | Core统一结果回填，invalid不执行，每调用一个协议结果             | 真实SDK/fetch请求捕获                             |
| F19 | 已结算等待必唤醒，abort失败受控结束而不授权                     | 真实Task故障注入/无uncaught/下次可发送            |
| F20 | 子代理轮final flush恰好一次，失败部分可回看；保存故障报告failed | error/iterator throw/abort+存储故障               |
| F21 | 编辑保留窗口配置，主动清空真正移除                              | Settings/Form真实组件+Profile真实E2E              |
| F22 | 设置初读失败可见错误/重试，成功前不写默认值                     | 五类分区真实Settings jsdom                        |
| F23 | 状态刷新代次驱动同路径diff更新与选中校验                        | Rail真实组件+Monaco E2E                           |
| F24 | compact保留未匹配旧子代理和稳定身份                             | 恢复/merge回归+压缩后右栏E2E                      |
| F25 | interrupted按终态判定，不隐藏主正文操作                         | 真恢复链→groupTurns→组件                          |
| F26 | 子工具两级按需展开完整参数/输出，安全纯文本                     | 长尾/错误/恢复jsdom+真实E2E                       |
| C01 | taskId+页面代次+独立queue水位，迟到保存不清新编辑               | deferred IPC/事件乱序/继续输入回归                |
| C02 | 新工具调用区分宿主ID/provider ID，不迁移旧库，消费释放委派entry | 主/子重复ID真实Task+SQLite+协议配对               |

对应实施票：

- [01 任务调度](issues/01-task-scheduling.md)
- [02 构建与Chromium](issues/02-build-chromium.md)
- [03 工具与生命周期](issues/03-tools-lifecycle.md)
- [04 存储与平台](issues/04-storage-platform.md)
- [05 核心协议](issues/05-core-protocol.md)
- [06 工作台与设置](issues/06-workspace-settings.md)
- [07 消息呈现](issues/07-message-rendering.md)

## 验证结果

### 默认命令

- `pnpm build && pnpm test`：**退出0**。
  - agent-core：52文件、587通过。
  - desktop：55文件、445通过、1跳过。
  - ui：53文件、538通过。
  - 总计：**160文件，1,570通过，1明确跳过**。
- `pnpm typecheck`、`pnpm lint`、`pnpm check:adr`、`pnpm check:e2e-locators`、`git diff --check`：**全部退出0**。
- 未隐藏warning：Lint 0 errors / 8 Fast Refresh warnings（原6条+新增Markdown混合导出2条）；Vite保留大chunk/依赖注释警告；原 `empty-import-meta` 已消失。
- 文件symlink测试因Windows `EPERM` 明确skip，不再作为普通通过；真实directory junction校验通过。

### 真实Electron专项

**19个相关场景通过**：

`task-queue-restart`、`input-queue`、`input-queue-pause`、`input-queue-restart`、`input-queue-items`、`compact`、`exit`、`commands`、`changes`、`persistence`、`scroll`、`thinking`、`subagents`、`subagent-thinking`、`subagent-recovery`、`subagent-interrupted`、`subagent-work-plan`、`subagent-legacy`、`reasoning-recovery`。

全部先构建，并使用临时业务及Electron userData/sessionData、本地假模型；未使用真实模型凭据或真实模型请求。较早验证的5项已在最后一次生产修补后复跑，避免旧dist假绿。

`subagent-interrupted` 的前提明确为已完成首次配置、正常退出持久化密钥，再开启任务进行强杀；不冒称该场景覆盖下一节的新鲜目录首启密钥问题。

未运行：全量E2E中的真实鼠标/系统剪贴板场景、NSIS安装卸载、真实浏览器下载、系统关机。`message-order.mjs` 已适配lazy读取并通过语法/定位器检查，但因包含真实剪贴板不实跑。

### 稳定性与独立复审

- 发现全核并发下既有真实Git测试超过默认5秒，定向通过；单变量限制4 workers后全Core通过，最终默认`pnpm test`也通过。仅控制测试资源并发，未放宽超时或弱化断言。
- Standards硬违反0；2条非阻塞重复代码建议保留，未为风格扩大重构。
- Spec及专项review共5条边界整改已完成，原审查者再读确认关闭。
- 中途失败及修正不隐去，详见INTEGRATION.md和各票红绿记录。

## 性能对照

| 场景                             | 修复前                              | 修复后                          |
| -------------------------------- | ----------------------------------- | ------------------------------- |
| 100条历史，计时tick/无关父更新   | 每次101次Markdown解析               | 0次                             |
| 100条历史，活动正文增量          | 历史也重解析，共101次               | 仅活动正文1次，未变历史0次      |
| 引用128MiB日志                   | 读取134,217,728字节，Buffer约128MiB | 读取131,073字节，Buffer约128KiB |
| 上述日志引用同步耗时（本机样本） | 约79–84ms                           | 约1.6–2.2ms                     |

耗时与硬件/缓存有关；稳定验收使用解析工作量和实际读量，不以这些毫秒数作为跨机器保证。活动段仍使用完整Markdown语义，75ms节流降低频率，不宣称已实现通用线性增量解析。

可重复性能脚本：[benchmarks/mentions.mjs](benchmarks/mentions.mjs)。解析次数由 `packages/ui/tests/message-rendering-ui.test.tsx` 固定数据集回归记录。

## 新发现：尚未修复

[08 Electron首次密钥耐久性](issues/08-electron-first-key-durability.md)：在全新目录首次加密后立即强杀，密文已经落业务文件，但Electron密钥可能仍未提交Local State，重启无法解密。已用无窗口真实Electron最小探针确认默认目录布局也受影响；DOM/cookie flush与弃用同步加密都不是修复。

这需要受支持的密钥耐久性/初始化方案或上游修正；本轮不猜私有密钥格式、不改明文、不删除配置、不用sleep掩盖。原审计项完成，但本新项保持开放，交付时必须明确。
