# 08: /compact 手动压缩

**What to build:** 用户在长会话中执行 `/compact`：当前模型把既有消息历史压缩为摘要，摘要替换旧历史、仅保留最近 3 轮原始对话，压缩记录入库，`/status` 显示「已压缩」状态与当前用量；压缩后继续对话上下文连贯。UI 在压缩过程中有状态提示，被压缩的历史折叠显示为一张摘要卡片（可展开看摘要全文）。

遵循 `GLOSSARY.md`（术语：Compact）；完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** 07 (AGENTS.md + 斜杠命令 + @引用 + /status)

**Status:** ready-for-agent

- [ ] `/compact` 触发压缩：旧历史替换为摘要 + 最近 3 轮原始对话
- [ ] 压缩记录与摘要入库；重启会话恢复后仍可见摘要卡片
- [ ] `/status` 显示已压缩标记与压缩后用量
- [ ] 压缩后对话上下文连贯（`MockLanguageModel` 断言注入的消息序列）
- [ ] 压缩过程中 UI 有进行中提示，不可重复触发
- [ ] 压缩请求失败时原历史不受损、可重试
