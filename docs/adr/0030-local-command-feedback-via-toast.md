---
status: partially superseded by ADR-0031（/status 报告回消息流带关闭按钮，其余反馈维持本文决定）
---

# 本地命令反馈走右下角 toast，不进消息流

斜杠命令与本地操作的即时反馈（`/status` 报告、`/compact` 结果、各操作失败提示等，共 28 个调用点）原先以 `kind:"status"` 本地 segment 插入对话消息流：位置上混入宿主历史（事件接续时需 `filter` 补丁特意保留），且无关闭交互、切任务前一直留存。决定全部迁往既有右下角 toast（票02 五类横条迁移的同一交互语言）：toast-state 新增一次性 API——不记 dismissedKeys（重复执行同命令是新事件，不是旧提示复活）、info 类约 6 秒自动消失、error 类常驻直到手关；`/status` 多行报告全文进主文案（ToastHost 补 `whitespace-pre-wrap` 与限高滚动）。消息流因此对命令完全无痕，与 GLOSSARY「斜杠命令与 UI 按钮等效」自洽；落库的宿主历史块（compact-summary、error）不受影响。曾考虑给消息流状态块加关闭按钮（交互前无先例、位置问题只解决一半）与 `/status` 专门浮层面板（仪表盘归宿正规但组件面膨胀），均弃。
