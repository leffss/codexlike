# 05: 剩余候选参数清单留档

**What to build:** 把本次不做、但调研发现可作为设置候选的参数落成带上下文的清单 issue，供后续 triage 分拣；同时记录「防护性上限不进设置」的边界，避免同样的调研重复发生。

**Blocked by:** None (can start immediately).

**Status:** needs-triage

## Parent

[执行设置 spec](../spec.md) 的 Out of Scope 一节；边界界定见 [ADR 0017](../../../docs/adr/0017-execution-settings.md)。

## Acceptance criteria

- [ ] 清单覆盖调研发现的全部候选：MCP 调用/连接超时、浏览器工具三类超时与输出截断、web_search 超时与结果数上限、read-file 行数上限、grep 结果数与单行截断、glob 结果数上限、AGENTS.md 注入体积、@引用大小、文件树扫描上限、commit-message 样本参数等，逐项给出语义、当前值与用户场景。
- [ ] 每项标注初步判断：值得进设置 / 属防护性护栏不建议暴露。
- [ ] 明确引用 ADR 0017 的范围界定，后续 triage 可直接据此分拣。

