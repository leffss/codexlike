import { afterEach, describe, expect, it, vi } from "vitest";
import { createToastManager } from "../src/lib/toast-state";

/** 提示内容样例（warn 类，对应上下文告警的形态） */
function warn(content: string) {
  return { kind: "warn" as const, content };
}

/** 命令反馈样例（info/error 类，对应本地命令反馈的形态） */
function info(content: string) {
  return { kind: "info" as const, content };
}

function error(content: string) {
  return { kind: "error" as const, content };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("toast 管理器（票02：渲染层内存态）", () => {
  it("show 后快照可见；多条堆叠保序，一条不漏", () => {
    const toasts = createToastManager();
    expect(toasts.toasts()).toEqual([]);
    toasts.show("context-warning", warn("上下文用量约为窗口的 82%"));
    toasts.show("task-auto-approve", {
      kind: "warn",
      content: "本任务已开启自动批准",
    });
    const snapshot = toasts.toasts();
    expect(snapshot.map((toast) => toast.id)).toEqual([
      "context-warning",
      "task-auto-approve",
    ]);
    expect(snapshot[0]?.content).toBe("上下文用量约为窗口的 82%");
  });

  it("同一 testId 重复 show 幂等更新：不重复堆叠，内容跟随最新", () => {
    const toasts = createToastManager();
    toasts.show(
      "workspace-sharing-notice",
      warn("共享文件风险：另有 1 个任务")
    );
    toasts.show("context-warning", warn("上下文用量约为窗口的 82%"));
    toasts.show(
      "workspace-sharing-notice",
      warn("共享文件风险：另有 2 个任务")
    );
    // 更新不改变首次插入的堆叠位置
    expect(toasts.toasts().map((toast) => toast.id)).toEqual([
      "workspace-sharing-notice",
      "context-warning",
    ]);
    expect(
      toasts.toasts().find((toast) => toast.id === "workspace-sharing-notice")
        ?.content
    ).toBe("共享文件风险：另有 2 个任务");
  });

  it("内存态：新建管理器即为空，实例间互不残留（不持久化）", () => {
    const first = createToastManager();
    first.show("context-warning", warn("上下文用量约为窗口的 82%"));
    expect(createToastManager().toasts()).toEqual([]);
  });

  it("dismiss 手动关闭后快照移除；状态持续期间同内容不再复活", () => {
    const toasts = createToastManager();
    toasts.show("task-auto-approve", {
      kind: "warn",
      content: "本任务已开启自动批准",
    });
    toasts.dismiss("task-auto-approve");
    expect(toasts.toasts()).toEqual([]);
    // 状态同步方重复 show 同内容（effect 重跑）不复活
    toasts.show("task-auto-approve", {
      kind: "warn",
      content: "本任务已开启自动批准",
    });
    expect(toasts.toasts()).toEqual([]);
  });

  it("dismiss 后内容变化视为新提示，重新可见", () => {
    const toasts = createToastManager();
    toasts.show("context-warning", warn("上下文用量约为窗口的 82%"));
    toasts.dismiss("context-warning");
    toasts.show("context-warning", warn("上下文用量约为窗口的 86%"));
    expect(toasts.toasts().map((toast) => toast.content)).toEqual([
      "上下文用量约为窗口的 86%",
    ]);
  });

  it("retract 随状态消失无条件移除；状态重现时同内容重新出现", () => {
    const toasts = createToastManager();
    toasts.show(
      "workspace-sharing-notice",
      warn("共享文件风险：另有 1 个任务")
    );
    toasts.retract("workspace-sharing-notice");
    expect(toasts.toasts()).toEqual([]);
    // 切换 Worktree 再切回 local：风险重现必须重新提示
    toasts.show(
      "workspace-sharing-notice",
      warn("共享文件风险：另有 1 个任务")
    );
    expect(toasts.toasts()).toHaveLength(1);
  });

  it("retract 清除 dismiss 的已确认记录：先关后消失再出现会重新提示", () => {
    const toasts = createToastManager();
    toasts.show("task-auto-approve", {
      kind: "warn",
      content: "本任务已开启自动批准",
    });
    toasts.dismiss("task-auto-approve");
    toasts.retract("task-auto-approve");
    toasts.show("task-auto-approve", {
      kind: "warn",
      content: "本任务已开启自动批准",
    });
    expect(toasts.toasts()).toHaveLength(1);
  });

  it("subscribe/version：变更时通知监听者，version 递增，退订后不再通知", () => {
    const toasts = createToastManager();
    expect(toasts.version()).toBe(0);
    let notified = 0;
    const unsubscribe = toasts.subscribe(() => {
      notified += 1;
    });
    toasts.show("context-warning", warn("上下文用量约为窗口的 82%"));
    expect(notified).toBe(1);
    expect(toasts.version()).toBe(1);
    // 无实际变化的重播不通知
    toasts.show("context-warning", warn("上下文用量约为窗口的 82%"));
    expect(notified).toBe(1);
    unsubscribe();
    toasts.dismiss("context-warning");
    expect(notified).toBe(1);
    expect(toasts.version()).toBe(2);
  });
});

describe("toast 管理器一次性反馈（ADR 0030：本地命令反馈走 toast）", () => {
  it("flash 后快照可见；同 id 新事件无条件顶替，不堆叠", () => {
    const toasts = createToastManager();
    toasts.flash("command-feedback", info("已压缩：12 条历史消息已替换为摘要"));
    toasts.flash("command-feedback", info("模型已切换：Mock · mock-model"));
    expect(toasts.toasts().map((toast) => toast.content)).toEqual([
      "模型已切换：Mock · mock-model",
    ]);
  });

  it("flash 不记 dismiss 确认：手动关掉后再执行同命令（同内容）重新可见", () => {
    const toasts = createToastManager();
    toasts.flash("command-feedback", info("已压缩：12 条历史消息已替换为摘要"));
    toasts.dismiss("command-feedback");
    expect(toasts.toasts()).toEqual([]);
    // 重复执行同命令是新事件（show 语义下同内容会被 dismissedKeys 吞掉）
    toasts.flash("command-feedback", info("已压缩：12 条历史消息已替换为摘要"));
    expect(toasts.toasts()).toHaveLength(1);
  });

  it("info 类 flash 约 6 秒自动消失；手动关闭立即移除且定时器不再复活", () => {
    vi.useFakeTimers();
    const toasts = createToastManager();
    toasts.flash("command-feedback", info("任务已重命名为「修托盘」"));
    expect(toasts.toasts()).toHaveLength(1);
    vi.advanceTimersByTime(5999);
    expect(toasts.toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toasts.toasts()).toEqual([]);
    // 手动关闭路径：定时器被清理，6 秒后没有多余通知
    toasts.flash("command-feedback", info("任务已重命名为「修托盘」"));
    toasts.dismiss("command-feedback");
    expect(toasts.toasts()).toEqual([]);
    let notified = 0;
    toasts.subscribe(() => {
      notified += 1;
    });
    vi.advanceTimersByTime(6000);
    expect(notified).toBe(0);
  });

  it("info 类 flash 被新事件顶替后旧定时器不再生效", () => {
    vi.useFakeTimers();
    const toasts = createToastManager();
    toasts.flash("command-feedback", info("第一条反馈"));
    vi.advanceTimersByTime(5000);
    toasts.flash("command-feedback", info("第二条反馈"));
    vi.advanceTimersByTime(1000);
    // 旧条目的 6 秒已到，但被顶替的是新事件，计时从头算
    expect(toasts.toasts().map((toast) => toast.content)).toEqual([
      "第二条反馈",
    ]);
    vi.advanceTimersByTime(5000);
    expect(toasts.toasts()).toEqual([]);
  });

  it("error 类 flash 常驻不自动消失，直到手动关闭", () => {
    vi.useFakeTimers();
    const toasts = createToastManager();
    toasts.flash("command-feedback", error("停止失败：任务已结束"));
    vi.advanceTimersByTime(60000);
    expect(toasts.toasts()).toHaveLength(1);
    toasts.dismiss("command-feedback");
    expect(toasts.toasts()).toEqual([]);
  });
});
