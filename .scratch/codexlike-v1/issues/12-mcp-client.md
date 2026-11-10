# 12: MCP 客户端（stdio）

**What to build:** 设置页可添加 stdio MCP server（命令、参数、环境变量），应用连接并列出其提供的工具；MCP 工具适配进统一工具注册表、在设置页可逐工具启停；会话中模型可调用启用的 MCP 工具，调用同样过审批模式（`suggest` 下弹审批卡片）。server 进程崩溃/启动失败/调用超时不拖垮会话，错误作为工具结果返回模型。基于 `@modelcontextprotocol/sdk`。

遵循 `GLOSSARY.md`（术语：MCP、工具注册表）；完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** 04 (审批模式三档 + 审批卡片)

**Status:** ready-for-agent

- [ ] 设置页：添加/删除 MCP server 配置，连接状态可见
- [ ] server 工具发现并入注册表；逐工具启停对会话生效
- [ ] `suggest` 模式下 MCP 工具调用弹审批卡片
- [ ] server 崩溃/超时的错误处理：会话存活、错误可读
- [ ] 进程内 fake MCP server 集成测试：发现→调用→结果回填
