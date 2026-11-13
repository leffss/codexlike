import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { QueuedMessage } from "@codexlike/desktop/ipc";
import { QueueBar } from "../src/components/QueueBar";

function queued(texts: string[]): QueuedMessage[] {
  return texts.map((text, index) => ({
    id: `q-${index}`,
    taskId: "s",
    position: index,
    text,
    mentionPaths: [],
    providerProfileId: "p",
    thinkingEffort: "auto",
    approvalMode: "ask",
    createdAt: "2026-11-13T00:00:00Z",
  }));
}

/** 递归收集带 data-testid 的元素（组件直调返回的元素树，不依赖 DOM 渲染） */
function collectByTestId(node: ReactNode, testId: string): any[] {
  const found: any[] = [];
  function walk(current: ReactNode) {
    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }
    if (typeof current !== "object" || current === null) return;
    const element = current as { props?: any };
    if (element.props?.["data-testid"] === testId) found.push(element);
    if (element.props?.children !== undefined) walk(element.props.children);
  }
  walk(node);
  return found;
}

it("输入队列条（票 01）：空队列不显示；有条目显示预览与待发条数", () => {
  expect(
    renderToStaticMarkup(
      createElement(QueueBar, {
        queueState: { queue: [], paused: false, sendingId: null },
      })
    )
  ).toBe("");
  const html = renderToStaticMarkup(
    createElement(QueueBar, {
      queueState: {
        queue: queued(["接着做第二步", "再跑一遍测试"]),
        paused: false,
        sendingId: null,
      },
    })
  );
  expect(html).toContain('data-testid="queue-bar"');
  expect(html).toContain("接着做第二步");
  expect(html).toContain("再跑一遍测试");
  expect(html).toContain('data-testid="queue-count"');
  // 计数口径（review 修复）：排队计数「待发 N」，无 inflight 时即全部条目
  expect(html).toContain("待发 2 条");
  // 不进消息流：预览在队列条内呈现，而非消息列表
  expect(html).not.toContain('data-testid="message-');
});

it("超过 5 条折叠为「+N 更多」，预览仍按顺序展示前 5 条", () => {
  const html = renderToStaticMarkup(
    createElement(QueueBar, {
      queueState: {
        queue: queued(["一", "二", "三", "四", "五", "六", "七"]),
        paused: false,
        sendingId: null,
      },
    })
  );
  for (const text of ["一", "二", "三", "四", "五"]) {
    expect(html).toContain(text);
  }
  expect(html).not.toContain(">六<");
  expect(html).not.toContain(">七<");
  expect(html).toContain('data-testid="queue-more"');
  expect(html).toContain("+2 更多");
  expect(html).toContain('data-testid="queue-count"');
  expect(html).toContain("待发 7 条");
});

it("正在发出的条目区别显示且锁定：无删除/取回编辑/拖拽入口（票 03）", () => {
  const queue = queued(["正在发出的一条", "排队的一条"]);
  const html = renderToStaticMarkup(
    createElement(QueueBar, {
      queueState: { queue, paused: false, sendingId: "q-0" },
    })
  );
  expect(html).toContain('data-testid="queue-item-sending"');
  expect(html).toContain("发送中");
  // 锁定：sending 条目行内不提供删除、取回编辑与拖拽入口
  const rows = html.split('data-testid="queue-item"').slice(1);
  expect(rows).toHaveLength(2);
  expect(rows[0]).not.toContain("queue-item-remove");
  expect(rows[0]).not.toContain("queue-item-drag");
  expect(rows[1]).toContain("queue-item-remove");
  expect(rows[1]).toContain("queue-item-drag");
});

it("计数口径（review 修复）：「待发 N」不含正在发出的条目，发送中单独标注", () => {
  const queue = queued(["甲", "乙", "丙"]);
  const html = renderToStaticMarkup(
    createElement(QueueBar, {
      queueState: { queue, paused: false, sendingId: "q-0" },
    })
  );
  // 排队计数只算仍在排队的条目（乙 + 丙），inflight 的甲不计入
  expect(html).toContain("待发 2 条");
  expect(html).not.toContain("待发 3 条");
  // inflight 以锁定态展示并单独标注「发送中」
  expect(html).toContain('data-testid="queue-item-sending-badge"');
  expect(html).toContain("发送中");
});

it("编辑中的条目显示「编辑中」与取消入口，其余条目不受影响（票 03）", () => {
  const html = renderToStaticMarkup(
    createElement(QueueBar, {
      queueState: {
        queue: queued(["甲", "乙"]),
        paused: false,
        sendingId: null,
      },
      editingItemId: "q-0",
    })
  );
  const rows = html.split('data-testid="queue-item"').slice(1);
  expect(rows[0]).toContain('data-testid="queue-item-editing"');
  expect(rows[0]).toContain('data-testid="queue-item-cancel-edit"');
  expect(rows[1]).not.toContain("queue-item-editing");
  expect(rows[1]).not.toContain("queue-item-cancel-edit");
});

it("取回编辑/删除/取消回调携带正确条目，锁定条目不触发编辑（票 03）", () => {
  const queue = queued(["甲", "乙"]);
  const onEdit = vi.fn();
  const onRemove = vi.fn();
  const onCancel = vi.fn();
  const tree = QueueBar({
    queueState: { queue, paused: false, sendingId: "q-0" },
    editingItemId: "q-1",
    onEditItem: onEdit,
    onRemove: onRemove,
    onCancelEdit: onCancel,
  });
  const previews = collectByTestId(tree, "queue-item-preview");
  expect(previews).toHaveLength(1);
  previews[0]!.props.onClick();
  expect(onEdit).toHaveBeenCalledWith(queue[1]);
  const removes = collectByTestId(tree, "queue-item-remove");
  expect(removes).toHaveLength(1);
  removes[0]!.props.onClick();
  expect(onRemove).toHaveBeenCalledWith("q-1");
  collectByTestId(tree, "queue-item-cancel-edit")[0]!.props.onClick();
  expect(onCancel).toHaveBeenCalledOnce();
});

it("拖放到目标行计算新顺序并排除正在发出的条目；无效拖放不触发重排（票 03）", () => {
  const onReorder = vi.fn();
  const queue = queued(["甲", "乙", "丙"]);
  const tree = QueueBar({
    queueState: { queue, paused: false, sendingId: "q-2" },
    onReorder,
  });
  const row = (id: string) =>
    collectByTestId(tree, "queue-item").find(
      (element) => element.props["data-item-id"] === id
    );
  expect(row("q-0")).toBeDefined();
  // 拖自身：无操作
  row("q-0")!.props.onDrop({
    preventDefault: vi.fn(),
    dataTransfer: { getData: () => "q-0" },
  });
  expect(onReorder).not.toHaveBeenCalled();
  // 未知来源：无操作
  row("q-1")!.props.onDrop({
    preventDefault: vi.fn(),
    dataTransfer: { getData: () => "unknown" },
  });
  expect(onReorder).not.toHaveBeenCalled();
  // 丙（正在发出）所在行不注册拖放目标：锁定行不作为重排落点
  expect(row("q-2")!.props.onDrop).toBeUndefined();
  // 真实重排：把乙拖到甲之前，提交的顺序只含仍在排队的条目
  row("q-0")!.props.onDrop({
    preventDefault: vi.fn(),
    dataTransfer: { getData: () => "q-1" },
  });
  expect(onReorder).toHaveBeenCalledWith(["q-1", "q-0"]);
});
