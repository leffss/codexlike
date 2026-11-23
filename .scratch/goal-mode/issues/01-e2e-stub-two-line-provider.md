# 01: e2e stub provider 两线脚本化（预构）

**What to build:** e2e 假 provider 具备两条脚本化响应线——「工作轮回复」（现有能力）与「判定回复」（新增）：能识别目标模式发起的完成判定请求（无工具、判定 prompt 特征），并按场景脚本应答 `{passed, reason, nextAction}`（含 code fence 包裹等容错形态）。附一个探针场景证明同一场景内两条线可分别脚本化驱动。后续目标模式各票的 e2e 都踩这条腿。

**Blocked by:** None（可立即开工）

**Status:** ready-for-agent

**上下文指针:** `.scratch/goal-mode/spec.md`（Testing Decisions）、`.scratch/goal-mode/notes.md`（e2e 纪律节：不接管道、dist 重建、stub/fake 先例）

- [ ] 假 provider 能按脚本对判定请求返回 `{passed, reason, nextAction}`，含容错形态用例（code fence / 字符串包裹）
- [ ] 探针场景证明同一场景内工作轮 / 判定轮可分别脚本化（互不串线）
- [ ] 既有 e2e 场景中受 provider 改动影响者实跑绿（全量回归在票 07 收口）
- [ ] 相关单测 / typecheck / build 绿
