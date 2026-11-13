import { describe, expect, it } from "vitest";

import {
  CONTEXT_WARNING_THRESHOLD_RATIO,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  evaluateContextWarning,
} from "../../src/context/context-warning";
import { estimateTokens } from "../../src/context/tokens";

/**
 * 上下文告警（code review 修复 2，spec 验收场景 4）：
 * 估算 → 阈值触发的纯逻辑——窗口（Profile 可配，默认 128k）× 80% 占比。
 */
describe("evaluateContextWarning", () => {
  it("低于阈值（窗口 × 80%）不告警", () => {
    expect(evaluateContextWarning(0, 128_000)).toBeNull();
    expect(evaluateContextWarning(101_999, 128_000)).toBeNull();
    // 阈值以下一丝也不触发（101_999.2 → false）
    expect(evaluateContextWarning(101_999, 128_000)).toBeNull();
  });

  it("达到阈值（≥ 80%）触发中文告警，含用量与 /compact 建议", () => {
    const warning = evaluateContextWarning(102_400, 128_000);
    expect(warning).not.toBeNull();
    expect(warning!.estimatedTokens).toBe(102_400);
    expect(warning!.contextWindowTokens).toBe(128_000);
    expect(warning!.ratio).toBeCloseTo(0.8, 5);
    expect(warning!.message).toContain("上下文即将耗尽");
    expect(warning!.message).toContain("102400");
    expect(warning!.message).toContain("/compact");
  });

  it("远超阈值持续告警（文案含百分比）", () => {
    const warning = evaluateContextWarning(120_000, 128_000);
    expect(warning).not.toBeNull();
    expect(warning!.message).toContain("94%");
  });

  it("未配置窗口（undefined）按默认 128k 估算", () => {
    expect(evaluateContextWarning(90_000, undefined)).toBeNull();
    const warning = evaluateContextWarning(104_000, undefined);
    expect(warning!.contextWindowTokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(warning!.message).toContain("128000");
  });

  it("Profile 配置小窗口时按配置触发（阈值 = 窗口 × 占比）", () => {
    // 8k 窗口：6400 = 80% 即触发
    expect(evaluateContextWarning(6_399, 8_000)).toBeNull();
    const warning = evaluateContextWarning(6_400, 8_000);
    expect(warning).not.toBeNull();
    expect(warning!.contextWindowTokens).toBe(8_000);
  });

  it("非法窗口值（≤0 / NaN）按默认处理", () => {
    expect(evaluateContextWarning(104_000, 0)).not.toBeNull();
    expect(evaluateContextWarning(104_000, Number.NaN)).not.toBeNull();
    expect(evaluateContextWarning(104_000, -5)?.contextWindowTokens).toBe(
      DEFAULT_CONTEXT_WINDOW_TOKENS
    );
  });

  it("常量口径：默认 128k、阈值 0.8", () => {
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(128_000);
    expect(CONTEXT_WARNING_THRESHOLD_RATIO).toBe(0.8);
  });
});

describe("估算 → 告警 的端到端纯逻辑（estimateTokens 喂给告警）", () => {
  it("长任务文本估算达到阈值触发；未达阈值不触发", () => {
    // 每条消息 400 CJK 字 → ceil(400/1.5) = 267 tokens/条（CJK 1.5 字符/token）
    const longMessage = "长".repeat(400);
    const perMessage = estimateTokens(longMessage);
    expect(perMessage).toBe(267);

    // 380 条 ≈ 101,460 tokens < 102,400（128k × 80%）：不告警
    const underThreshold = perMessage * 380;
    expect(underThreshold).toBeLessThan(128_000 * 0.8);
    expect(evaluateContextWarning(underThreshold, 128_000)).toBeNull();

    // 翻倍后超过 102_400 触发
    const doubled = perMessage * 760;
    const warning = evaluateContextWarning(doubled, 128_000);
    expect(warning).not.toBeNull();
    expect(warning!.estimatedTokens).toBe(doubled);
    expect(warning!.message).toContain("/compact");
  });
});
