# 07: MCP 调用与连接超时进设置

**What to build:** 用户在设置页 MCP 分区调整 MCP 工具调用超时与连接建立超时：慢外部 server 的工具调用与连接不再被 30s/15s 默认值掐断。改动即时保存，下一次连接/工具调用按新值执行（逐次解析，无回合快照）。来源：06-candidate-params-inventory.md 判定「值得进设置——MCP 已有设置分区，接线自然」。

**Blocked by:** None (can start immediately)——复用已合并的执行设置模式（票 01–04），在 main 直接实现（trunk 惯例，单票规模）。

**Status:** done

## Parent

[候选清单 06](06-candidate-params-inventory.md) 与 [ADR 0017](../../../docs/adr/0017-execution-settings.md)（注入范式与「非法输入回退默认」边界）；实现模式范本：票 04 对 terminal.ts 的 resolver 化（提交 bd61fb7/e4c85ff）与票 01–03 的 agent-settings 扩展。

## Acceptance criteria

- [x] MCP 分区新增两项数字输入（默认 30/15、范围 5–300/5–120），非法输入回退默认。
- [x] agent-settings.json 扩展两字段：旧格式文件缺字段按默认补齐，损坏回退，set 逐项校验。
- [x] manager 经函数形态逐次解析消费（connect 与 call 各自读当前值）；静态形态与默认行为不回归。
- [x] 三层测试覆盖：manager 行为（函数注入生效/逐次读取）、desktop store 与 IPC（六字段形状、校验、损坏回退）、ui 分区渲染与解析回退。
- [x] 全量测试与 typecheck 全绿；默认值 30s/15s 下既有 MCP 测试不回归。

## Comments

- 实现提交 7e367b1（main，17 文件 +889/-35）：agent-core 471 / desktop 291 / ui 359 全绿，typecheck 0。
- 附带正确性处理：执行分区与 MCP 分区共用 agent-settings.json（六字段整体形状），各分区保存时对非本分区字段读最新值回传，避免装载快照覆盖并发保存。

## 实现决定（延续既有模式，不再开 ADR）

- 存储：agent-settings.json 扩展 `mcpCallTimeoutSeconds`（默认 30、范围 5–300）与 `mcpConnectTimeoutSeconds`（默认 15、范围 5–120）——秒存储与终端超时同构，UI 直观；常量单一来源落 agent-core `task/execution-settings.ts` 经根出口导出（延续「防数字分叉」原则，同时把 manager.ts 的 MCP_DEFAULT_*_MS 默认值收敛到同源）。
- 注入：manager options 的 `callTimeoutMs/connectTimeoutMs` 升级为静态值或逐次解析函数（与 terminal.ts 的 TimeoutOption 同构）；连接建立与工具调用两处消费点逐次解析——设置保存后下一次连接/调用生效，无需重启。
- UI：MCP 分区（McpSettingsSection）新增「工具调用超时（5-300 秒）」「连接超时（5-120 秒）」数字输入 + 保存交互，与终端分区两项同构；默认 30/15。
- 校验与回退：两层同既有——UI 保存前拦截非法输入；store 读取侧越界/损坏回退默认；IPC 边界 parse 拒绝非法形状。

## Acceptance criteria

- [ ] MCP 分区新增两项数字输入（默认 30/15、范围 5–300/5–120），非法输入回退默认。
- [ ] agent-settings.json 扩展两字段：旧格式文件缺字段按默认补齐，损坏回退，set 逐项校验。
- [ ] manager 经函数形态逐次解析消费（connect 与 call 各自读当前值）；静态形态与默认行为不回归。
- [ ] 三层测试覆盖：manager 行为（函数注入生效/逐次读取）、desktop store 与 IPC（六字段形状、校验、损坏回退）、ui 分区渲染与解析回退。
- [ ] 全量测试与 typecheck 全绿；默认值 30s/15s 下既有 MCP 测试不回归。
