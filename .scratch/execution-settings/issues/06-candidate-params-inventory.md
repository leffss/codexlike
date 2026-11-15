# 06: 可进设置的工具参数候选清单

**What this is:** ADR 0017 执行设置调研中未纳入本次的候选参数清单，供 triage 分拣。分拣依据：ADR 0017 的边界——只暴露「用户可能想调」的参数，防护性护栏不进设置；接线成本参考（是否已有 options 入口 / resolver 链路可复用）。

**Status:** needs-triage

## 候选清单

| 参数                                                                                           | 当前值          | 位置                                                  | 语义与用户场景                                              | 初步判断                                                               |
| ---------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| MCP 工具调用超时 `MCP_DEFAULT_CALL_TIMEOUT_MS`                                                 | 30s             | `agent-core/src/mcp/manager.ts:18`                    | 外部 MCP server 快慢差异大，慢 server 的工具调用被 30s 掐断 | ~~值得进设置~~ 已实现（票 07，提交 7e367b1：默认 30、范围 5–300 秒）   |
| MCP server 连接超时 `MCP_DEFAULT_CONNECT_TIMEOUT_MS`                                           | 15s             | `agent-core/src/mcp/manager.ts:20`                    | 慢启动的 server 连接失败                                    | ~~值得进设置~~ 已实现（票 07：默认 15、范围 5–120 秒）                 |
| 浏览器导航/操作/截图超时 `NAVIGATE_TIMEOUT_MS` / `ACTION_TIMEOUT_MS` / `SCREENSHOT_TIMEOUT_MS` | 30s / 10s / 30s | `agent-core/src/browser/tools.ts:32-34`               | 慢站点场景可调                                              | 可进设置——进阶项，优先级低                                             |
| browser_read 输出截断 `BROWSER_READ_MAX_CHARS`                                                 | 30000           | `agent-core/src/browser/tools.ts:29`                  | 大页面读取被截断                                            | 偏防护性，低优先                                                       |
| web_search 超时 `DEFAULT_TIMEOUT_MS`                                                           | 15s             | `agent-core/src/tools/web-search.ts:45`               | 慢搜索源                                                    | 低优先                                                                 |
| web_search 结果数上限 `MAX_RESULTS_LIMIT`                                                      | 10              | `agent-core/src/tools/web-search.ts:46`               | 想要更多搜索结果                                            | 可进设置——用户感知直接                                                 |
| read-file 单次行数上限 `maxLines`                                                              | 2000            | `agent-core/src/tools/read-file.ts:15`                | 大文件分页读取                                              | 防护性护栏，不建议暴露                                                 |
| grep 结果数 / 单行截断                                                                         | 100 / 500       | `agent-core/src/tools/grep.ts:20-21`                  | 大仓库搜索被截断                                            | 防护性护栏，不建议暴露                                                 |
| glob 结果数 `maxResults`                                                                       | 200             | `agent-core/src/tools/glob.ts:15`                     | 大目录枚举                                                  | 防护性护栏，不建议暴露                                                 |
| AGENTS.md 注入体积 `AGENTS_MD_MAX_BYTES`                                                       | 32KB            | `agent-core/src/context/agents-md.ts:14`              | 超大规范文件被截断                                          | 防护性护栏，不建议暴露                                                 |
| @引用文件体积 `MENTION_MAX_BYTES`                                                              | 128KB           | `packages/desktop/src/tasks/mentions.ts:7`            | 大文件引用被拒                                              | 防护性护栏，不建议暴露                                                 |
| 工作区文件树扫描上限 / 深度                                                                    | 2000 / 16       | `packages/desktop/src/tasks/workspace-files.ts:19,22` | 深树大仓库                                                  | 防护性护栏，不建议暴露                                                 |
| commit-message 生成样本参数                                                                    | 20 / 400 / 50   | `agent-core/src/git/commit-message.ts:11-15`          | 提交信息生成质量                                            | 内部调参，不建议暴露                                                   |
| 上下文窗口缺省值 `DEFAULT_CONTEXT_WINDOW_TOKENS`                                               | 128000          | `agent-core/src/context/context-warning.ts:9`         | —                                                           | 不进设置：Provider Profile 已可逐模型配置，重复入口（ADR 0017 已界定） |

## 参考

- 范围界定与注入模式：[ADR 0017](../../../docs/adr/0017-execution-settings.md)
- 已实现为设置的六项：[spec](../spec.md)（工具轮次上限×2、压缩保留轮数、告警阈值进「执行」分区；终端超时两项进终端分区）
- 注入先例：notes.md 记录的三条 resolver 链路（子代理并发 / 终端 shell / 搜索源）
