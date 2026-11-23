# 01: e2e stub provider 两线脚本化（预构）

**What to build:** e2e 假 provider 具备两条脚本化响应线——「工作轮回复」（现有能力）与「判定回复」（新增）：能识别目标模式发起的完成判定请求（无工具、判定 prompt 特征），并按场景脚本应答 `{passed, reason, nextAction}`（含 code fence 包裹等容错形态）。附一个探针场景证明同一场景内两条线可分别脚本化驱动。后续目标模式各票的 e2e 都踩这条腿。

**Blocked by:** None（可立即开工）

**Status:** done

**上下文指针:** `.scratch/goal-mode/spec.md`（Testing Decisions）、`.scratch/goal-mode/notes.md`（e2e 纪律节：不接管道、dist 重建、stub/fake 先例）

- [x] 假 provider 能按脚本对判定请求返回 `{passed, reason, nextAction}`，含容错形态用例（code fence / 字符串包裹）
- [x] 探针场景证明同一场景内工作轮 / 判定轮可分别脚本化（互不串线）
- [x] 既有 e2e 场景中受 provider 改动影响者实跑绿（全量回归在票 07 收口）
- [x] 相关单测 / typecheck / build 绿

## Comments

（写给票 02/03 及后续目标模式 e2e 的衔接说明，2026-11-23 票 01 实现轮）

### 交付物

- `packages/desktop/e2e/goal-stub.mjs`：判定线核心模块——`GOAL_VERIFICATION_MARKER`、`isGoalVerificationRequest`（默认识别）、`goalVerdictText`（三形态构造）、`startGoalMockProvider`（双线声明式工厂，一站式 re-export `startMockProvider`）。
- `packages/desktop/e2e/goal-stub.d.mts`：手写 TS 声明（供 tests/ 的 .ts 单测与 typecheck；与 .mjs 导出有同步义务）。
- `packages/desktop/e2e/helpers.mjs`：`startMockProvider` 新增可选第三参 `options = { isVerdictRequest, onVerdict }`——不传时行为与旧签名逐字节一致（既有 50 个场景零改动零影响）。
- `packages/desktop/e2e/goal-stub-probe.mjs`：探针场景（script：`test:e2e:goal-stub`，已入 `test:e2e:all` 链尾）。
- `packages/desktop/tests/e2e-stub/goal-stub.test.ts`：单测 14 用例。

### 票 02 对接契约（判定请求识别特征——票 02 落地判定调用时必须满足）

默认识别 `isGoalVerificationRequest(bodyText)` 为**请求体文本级匹配**，两条件同时满足才路由到判定线：

1. **无工具**：请求体不含非空 `tools` 数组（无 `tools` 字段或空数组均可）——工作轮 streamText 必带非空 tools；票 02 判定调用走 `generateText`（天然无 tools，compact 先例）或不带 tools 的 streamText 都满足；
2. **判定 prompt 标记**：请求体含 `[goal-verification]`（英文稳定标记，**票 02 构造判定 system prompt 时务必携带，建议置于首部**）或中文「完成判定」措辞（容错）。

不满足者一律走工作轮线（提交消息生成、compact 摘要等既有非流式请求不受影响）。识别逻辑整体可通过 `startGoalMockProvider({ isVerdictRequest })` 注入替换，票 02 若判定 prompt 无法带英文标记，改注入即可、无需动 stub。

### 场景用法示例

```js
const { server, port } = await startGoalMockProvider({
  work(ctx, { index }) {
    // 与 startMockProvider 的 onChat 同契约；index 只数工作轮请求
    ctx.textRound("工作轮回复");
  },
  verdict(ctx, { index }) {
    // index 只数判定请求；verdictRound 自动适配请求的 stream 字段：
    // 非流式 → chat completion JSON；流式 → SSE 文本帧。票 02 选哪种调用路径都能踩。
    ctx.verdictRound(
      index === 1
        ? { passed: false, reason: "尚有步骤未完成", nextAction: "继续实现" }
        : { passed: true, reason: "目标已达成", nextAction: "无" },
      index === 1 ? "raw" : "code-fence" // 形态：raw / code-fence / string-wrapped
    );
  },
});
```

### 探针场景的两线证明方式（票 03 落地后部分退役）

目标模式本体未落地，探针场景中判定请求由**测试进程直接 POST mock server 模拟**（请求体按上述契约构造），工作轮请求由真实应用经真实 UI 发起——同一 provider 实例上 4 个请求两线分账、双方脚本各设越界哨兵，任何串线都会让哨兵文本泄漏到断言。票 03 落地后真实判定请求由应用发起，探针的 fetch 模拟部分保留作 stub 层回归即可；届时场景可改用真实 `/goal` 流程驱动判定线。

### 踩坑点

- **识别是文本级 includes 匹配**（沿 compact.mjs 的 body 特征分流先例，非 JSON 解析）：消息历史文本里出现 `"tools": [...]` 字样会把该请求误判为工作轮——e2e 场景内可控，勿在目标文本里写工具 JSON。
- **`requestCount()` 计全部 chat 请求（含判定）**，`onChat` 的 `index` 只数工作轮请求——不传 options 时二者恒等，既有依赖全局序号的场景零影响。
- `verdictRound` 返回构造的文本，场景断言可直接用返回值（也可用 `goalVerdictText` 独立构造期望值）。
- work / verdict 脚本缺省时有占位应答（「未脚本化」文案），漏配立刻可见而非静默挂起。
- stub 改动只涉及 e2e/ 与 tests/，不涉 desktop src/——e2e 前置的 dist 新鲜度检查天然通过；但跑探针前仍需全仓 build（新 worktree 首次）。
