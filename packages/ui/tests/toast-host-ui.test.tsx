import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ToastHost } from "../src/components/ToastHost";
import type { ToastEntry } from "../src/lib/toast-state";

/** 与 createToastManager().show 后快照形状一致的条目样例 */
function entry(overrides: Partial<ToastEntry> = {}): ToastEntry {
  return {
    id: "context-warning",
    key: "context-warning\n上下文用量约为窗口的 82%",
    kind: "warn",
    content: "上下文用量约为窗口的 82%",
    ...overrides,
  };
}

it("无提示时不渲染任何节点，消息流上方与右下角都保持干净", () => {
  expect(
    renderToStaticMarkup(
      createElement(ToastHost, { toasts: [], onDismiss: () => {} })
    )
  ).toBe("");
});

it("多条堆叠渲染：右下角浮层容器，每条带原横条 testid 与状态语义", () => {
  const html = renderToStaticMarkup(
    createElement(ToastHost, {
      toasts: [
        entry({
          id: "context-warning",
          kind: "warn",
          content: "上下文用量约为窗口的 82%",
        }),
        entry({
          id: "workbench-save-error",
          kind: "error",
          content: "工作现场保存失败：磁盘已满",
        }),
        entry({
          id: "unavailable-profile",
          kind: "error",
          content: "已保存的模型配置不可用，请重新选择模型；不会自动替换。",
        }),
      ],
      onDismiss: () => {},
    })
  );
  // 浮层容器：右下角定位 + 区域标识
  expect(html).toMatch(
    /data-testid="toast-region"[^>]*class="[^"]*fixed[^"]*bottom-20[^"]*right-6/
  );
  // 每条沿用被删除横条的 testid；error 条目 role=alert，warn 条目 role=status
  expect(html).toContain('data-testid="context-warning"');
  expect(html).toContain('data-testid="workbench-save-error"');
  expect(html).toMatch(/data-testid="workbench-save-error"[^>]*role="alert"/);
  expect(html).toMatch(/data-testid="unavailable-profile"[^>]*role="alert"/);
  expect(html).toMatch(/data-testid="context-warning"[^>]*role="status"/);
  // 文案完整可见，一条不漏
  expect(html).toContain("上下文用量约为窗口的 82%");
  expect(html).toContain("工作现场保存失败：磁盘已满");
  expect(html).toContain("已保存的模型配置不可用");
});

/** 递归收集带 data-testid 的元素（组件直调返回的元素树，不依赖 DOM 渲染；先例：queue-bar-ui） */
function collectByTestId(
  node: unknown,
  testId: string
): Array<{ props: Record<string, unknown> }> {
  const found: Array<{ props: Record<string, unknown> }> = [];
  function walk(current: unknown) {
    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }
    if (typeof current !== "object" || current === null) return;
    const element = current as { props?: Record<string, unknown> };
    if (element.props?.["data-testid"] === testId)
      found.push(element as { props: Record<string, unknown> });
    if (element.props?.children !== undefined) walk(element.props.children);
  }
  walk(node);
  return found;
}

it("每条带独立关闭按钮，点击透传对应条目 id（先例：queue-bar-ui 元素树直读）", () => {
  const onDismiss = vi.fn();
  const element = createElement(ToastHost, {
    toasts: [
      entry({ id: "context-warning" }),
      entry({
        id: "workbench-save-error",
        kind: "error",
        content: "工作现场保存失败：磁盘已满",
      }),
    ],
    onDismiss,
  });
  const html = renderToStaticMarkup(element);
  expect(html).toContain('data-testid="context-warning-close"');
  expect(html).toContain('data-testid="workbench-save-error-close"');
  expect(html).toMatch(/aria-label="关闭提示"/);
  // 关闭按钮的 onClick 在元素树中直接调用，验证透传的是对应条目 id
  const tree = ToastHost(element.props);
  collectByTestId(tree, "context-warning-close").forEach((button) => {
    (button.props.onClick as () => void)();
  });
  collectByTestId(tree, "workbench-save-error-close").forEach((button) => {
    (button.props.onClick as () => void)();
  });
  expect(onDismiss.mock.calls.map(([id]) => id)).toEqual([
    "context-warning",
    "workbench-save-error",
  ]);
});

it("kind 决定外观语义 token：warn/danger 走状态色，info 走中性面", () => {
  const html = renderToStaticMarkup(
    createElement(ToastHost, {
      toasts: [
        entry({ id: "context-warning", kind: "warn" }),
        entry({
          id: "workbench-save-error",
          kind: "error",
          content: "保存失败",
        }),
        entry({
          id: "workspace-sharing-notice",
          kind: "info",
          content: "另有 1 个运行中任务",
        }),
      ],
      onDismiss: () => {},
    })
  );
  expect(html).toMatch(
    /data-testid="context-warning"[^>]*class="[^"]*bg-warn-bg[^"]*text-warn-fg/
  );
  expect(html).toMatch(
    /data-testid="workbench-save-error"[^>]*class="[^"]*bg-danger-bg[^"]*text-danger-fg/
  );
  expect(html).toMatch(
    /data-testid="workspace-sharing-notice"[^>]*class="[^"]*bg-surface[^"]*text-fg-muted/
  );
});

it("contentTestId 落在主文案段（共享提示 warning/error 子定位沿用）", () => {
  const html = renderToStaticMarkup(
    createElement(ToastHost, {
      toasts: [
        entry({
          id: "workspace-sharing-notice",
          kind: "warn",
          content: "共享文件风险：另有 1 个任务正在同一实际目录执行",
          contentTestId: "workspace-sharing-warning",
        }),
      ],
      onDismiss: () => {},
    })
  );
  expect(html).toMatch(
    /data-testid="workspace-sharing-warning"[^>]*>共享文件风险：另有 1 个任务正在同一实际目录执行</
  );
});

it("多行报告全文进 toast：主文案保留换行，条目限高可滚动（ADR 0030 /status）", () => {
  const report = [
    "任务状态（/status）",
    "模型：Mock · mock-model",
    "上下文用量（估算）：约 1234 tokens（8 条消息 + 系统提示）",
    "任务用量：输入 12000 / 输出 3400 tokens（其中子代理 输入 800 / 输出 200）",
  ].join("\n");
  const html = renderToStaticMarkup(
    createElement(ToastHost, {
      toasts: [
        entry({
          id: "command-feedback",
          kind: "info",
          content: report,
        }),
      ],
      onDismiss: () => {},
    })
  );
  // 条目容器限高 + 滚动
  expect(html).toMatch(
    /data-testid="command-feedback"[^>]*class="[^"]*max-h-64[^"]*overflow-y-auto/
  );
  // 主文案段 whitespace-pre-wrap，换行原样保留
  expect(html).toMatch(
    /class="[^"]*whitespace-pre-wrap[^"]*">任务状态（\/status）\n模型：Mock · mock-model/
  );
});

it("操作与说明段渲染：自动批准条带撤销按钮、后果说明与失败提示", () => {
  const onAction = vi.fn();
  const props: { toasts: ToastEntry[]; onDismiss: () => void } = {
    toasts: [
      entry({
        id: "task-auto-approve",
        kind: "warn",
        content: "本任务已开启自动批准",
        detail: "取消后恢复基础审批模式的允许策略，不撤回已批准的执行。",
        action: {
          testId: "task-auto-approve-revoke",
          label: "取消自动批准",
          disabled: false,
          onAction,
        },
      }),
      entry({
        id: "task-auto-approve-busy",
        key: "busy",
        kind: "warn",
        content: "本任务已开启自动批准",
        detail: "取消后恢复基础审批模式的允许策略，不撤回已批准的执行。",
        action: {
          testId: "task-auto-approve-revoke",
          label: "取消中…",
          disabled: true,
          onAction,
        },
        actionError: "撤销失败：连接已断开",
      }),
    ],
    onDismiss: () => {},
  };
  const html = renderToStaticMarkup(createElement(ToastHost, props));
  expect(html).toContain("本任务已开启自动批准");
  expect(html).toContain("取消后恢复基础审批模式的允许策略");
  expect(html).toMatch(
    /data-testid="task-auto-approve-revoke"[^>]*>取消自动批准</
  );
  expect(html).toMatch(/data-testid="task-auto-approve-revoke"[^>]*disabled/);
  expect(html).toContain("取消中…");
  expect(html).toMatch(/role="alert"[^>]*>撤销失败：连接已断开</);
});
