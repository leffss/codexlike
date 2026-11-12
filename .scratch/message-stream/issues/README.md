# 消息流重构实施任务索引

[正式规格](../spec.md)、六张票及依赖已获用户确认并授权实施。决策过程:grilling 会话逐项确认 → [ADR 0011](../../../docs/adr/0011-message-stream-timeline-model-and-reasoning-persistence.md) 与 [GLOSSARY](../../../GLOSSARY.md) 沉淀 → [ZCode 调研报告](../../../docs/research/zcode-message-stream.md) 为设计参考。测试接缝三处:会话视图 reducer 单测、跟随纯函数单测(新)、Electron e2e。

| 票号 | 任务                                                               | 直接阻塞       | 当前状态  |
| ---- | ------------------------------------------------------------------ | -------------- | --------- |
| 01   | [时序消息段模型与按时序渲染](01-timeline-message-segment-model.md) | 无             | completed |
| 02   | [reasoning 落库与恢复](02-reasoning-persistence.md)                | 01             | completed |
| 03   | [滚动跟随状态机](03-scroll-following-state-machine.md)             | 01             | completed |
| 04   | [已工作折叠区与轮次分组](04-worked-history-collapse.md)            | 01(与 03 并行) | completed |
| 05   | [容器分档宽度](05-container-width-tiers.md)                        | 无(与 01 并行) | completed |
| 06   | [集成验收](06-integration-acceptance.md)                           | 01–05          | completed |

## 交付与验收

每张票为独立纵向切片,自带真实红绿与检查记录;06 不替代前置票测试,只做组合验收。硬约束:既有 23 个 e2e 场景在任何票合入后保持全绿(尤其阅读位置 <4px 精度、thinking 折叠交互、切换恢复类断言)。检查命令直接运行取退出码,不接管道。术语以 GLOSSARY 为准;实施 PR 与代码注释沿用"消息段、轮次、跟随、已工作折叠区"。
