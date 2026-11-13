import { describe, expect, it } from "vitest";

import { createInterruptRegistry } from "../../src/tasks/interrupt-registry";

/**
 * 中断注册表（工单 06）：desktop 主进程为每条运行中的消息流登记 AbortController，
 * 停止按钮经 IPC 打断 → abort() 贯穿 agent-core 流式层与工具执行层。
 */
describe("createInterruptRegistry（任务流的 AbortController 登记）", () => {
  it("begin 后 interrupt 返回 true，signal 被 abort", () => {
    const registry = createInterruptRegistry();
    const controller = registry.begin("session-1");

    expect(controller.signal.aborted).toBe(false);
    expect(registry.interrupt("session-1")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("流结束（end）后 interrupt 返回 false；从未 begin 的任务也是 false", () => {
    const registry = createInterruptRegistry();
    const controller = registry.begin("session-1");
    registry.end("session-1", controller);

    expect(registry.interrupt("session-1")).toBe(false);
    expect(registry.interrupt("nope")).toBe(false);
  });

  it("多任务并行互不干扰：只打断目标任务", () => {
    const registry = createInterruptRegistry();
    const a = registry.begin("session-a");
    const b = registry.begin("session-b");

    expect(registry.interrupt("session-a")).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);

    registry.end("session-a", a);
    expect(registry.interrupt("session-b")).toBe(true);
    expect(b.signal.aborted).toBe(true);
  });

  it("同一任务流结束后可再次 begin；迟到的 end 不清掉下一条流的登记", () => {
    const registry = createInterruptRegistry();
    const first = registry.begin("session-1");
    registry.end("session-1", first);

    const second = registry.begin("session-1");
    expect(second).not.toBe(first);
    // 第一条流的 finally 迟到执行：不能清掉第二条流的登记
    registry.end("session-1", first);
    expect(registry.interrupt("session-1")).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });
});
