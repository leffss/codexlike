import type { TaskListItem } from "@codexlike/desktop/ipc";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { TaskActivityBadge } from "../src/components/TaskActivityBadge";
import { TaskSidebar } from "../src/components/TaskSidebar";

function task(overrides: Partial<TaskListItem> = {}): TaskListItem {
  return {
    id: "task",
    projectId: null,
    title: "这是一条应优先占满剩余宽度且只显示一行的完整任务标题",
    workspacePath: "C:/work/demo",
    workspaceMode: "local",
    workspaceOriginPath: null,
    providerProfileId: null,
    model: null,
    status: "idle",
    approvalMode: "ask",
    archivedAt: null,
    createdAt: "2026-11-13T08:00:00Z",
    updatedAt: "2026-11-13T10:59:00Z",
    lastUsedAt: "2026-11-13T10:55:00Z",
    ...overrides,
  };
}

function renderSidebar(item: TaskListItem) {
  return renderToStaticMarkup(
    createElement(TaskSidebar, {
      projects: [],
      tasks: [item],
      currentId: item.id,
      creating: false,
      onAddProject() {},
      onCreateInProject() {},
      onSelect() {},
      onCreate() {},
      onMembership() {},
      onRename() {},
      onArchive() {},
      onPin() {},
      onPinProject() {},
      onCollapseProject() {},
    })
  );
}

// 保留原始 SSR 结构，避免浏览器解析器自动修复嵌套按钮而漏报。
function elementByTestId(html: string, testId: string) {
  const opening = new RegExp(
    `<([a-z][a-z0-9-]*)\\b[^>]*data-testid="${testId}"[^>]*>`
  ).exec(html);
  if (!opening) throw new Error(`缺少 data-testid="${testId}"`);
  const tag = opening[1]!;
  const contentStart = opening.index + opening[0].length;
  const tags = new RegExp(`</?${tag}\\b[^>]*>`, "g");
  tags.lastIndex = contentStart;
  let depth = 1;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      return {
        tag,
        opening: opening[0],
        content: html.slice(contentStart, match.index),
        html: html.slice(opening.index, tags.lastIndex),
      };
    }
  }
  throw new Error(`未闭合 data-testid="${testId}"`);
}

function attribute(opening: string, name: string) {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(opening)?.[1];
}

function classes(opening: string) {
  return (attribute(opening, "class") ?? "").split(/\s+/);
}

function textContent(html: string) {
  return html.replace(/<[^>]*>/g, "");
}

function expectCompactLabel(html: string, label: string) {
  expect(textContent(html)).toBe(label);
  const screenReaderLabel = html.match(
    /<span\b[^>]*class="[^"]*\bsr-only\b[^"]*"[^>]*>([^<]*)<\/span>/
  );
  expect(screenReaderLabel?.[1]).toBe(label);
  expect(html).toMatch(/<(?:svg|span)\b[^>]*aria-hidden="true"/);
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("项目置顶入口是独立键盘按钮，置顶标识与空项目均保留", () => {
  const html = renderToStaticMarkup(
    createElement(TaskSidebar, {
      projects: [
        {
          id: "p",
          name: "空项目",
          workspacePath: "/work",
          createdAt: "2026-11-12",
          pinned: true,
        },
      ],
      tasks: [],
      currentId: null,
      creating: false,
      onAddProject() {},
      onCreateInProject() {},
      onSelect() {},
      onCreate() {},
      onMembership() {},
      onRename() {},
      onArchive() {},
      onPin() {},
      onPinProject() {},
      onCollapseProject() {},
    })
  );
  expect(html).toContain('data-testid="project-pinned"');
  expect(html).toMatch(
    /<button[^>]*data-testid="project-pin"[^>]*aria-pressed="true"/
  );
  expect(html).toContain('aria-label="取消项目置顶"');
  expect(html).toContain("group-focus-within/header:opacity-100");
  expect(html.indexOf('data-testid="project-header"')).toBeLessThan(
    html.indexOf('data-testid="standalone-header"')
  );
});

it("顶栏图标化：统一新建入口收进菜单（闭合态），独立任务组头保留悬停加号", () => {
  const html = renderToStaticMarkup(
    createElement(TaskSidebar, {
      projects: [
        {
          id: "p1",
          name: "演示项目",
          workspacePath: "/work",
          createdAt: "2026-11-12",
        },
      ],
      tasks: [],
      currentId: null,
      creating: false,
      onAddProject() {},
      onCreateInProject() {},
      onSelect() {},
      onCreate() {},
      onMembership() {},
      onRename() {},
      onArchive() {},
      onPin() {},
      onPinProject() {},
      onCollapseProject() {},
    })
  );
  // 标题文案与整行按钮移除（原型 prototype/sidebar-buttons 变体 A 定稿）
  expect(html).toContain("任务列表");
  expect(html).not.toContain("+ 新建独立任务");
  // 统一新建入口：图标按钮 + menu 语义，SSR 初始态闭合
  expect(html).toMatch(
    /<button[^>]*data-testid="new-task"[^>]*aria-haspopup="menu"/
  );
  expect(html).toMatch(
    /<button[^>]*data-testid="new-task"[^>]*aria-expanded="false"/
  );
  expect(html).not.toContain('role="menu"');
  // 添加项目为图标按钮（aria-label 承担可访问名称）
  expect(html).toMatch(
    /<button[^>]*data-testid="add-project"[^>]*aria-label="添加项目"/
  );
  // 独立任务组头悬停「+」与项目组头同模式
  expect(html).toMatch(
    /<button[^>]*data-testid="standalone-new-task"[^>]*aria-label="新建独立任务"/
  );
  // 两种组头的计数在悬停时都让位隐藏
  expect(
    (html.match(/group-hover\/header:invisible/g) ?? []).length
  ).toBeGreaterThanOrEqual(2);
});
it.each([
  {
    name: "最近使用时间",
    lastUsedAt: "2026-11-13T10:55:00Z",
    relative: "5 分钟前",
  },
  {
    name: "缺少最近使用时间时回退到创建时间",
    lastUsedAt: undefined,
    relative: "3 小时前",
  },
])(
  "单行标题优先伸缩，tooltip 保留完整标题、路径和$name",
  ({ lastUsedAt, relative }) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-13T11:00:00Z"));
    const item = task({ lastUsedAt });
    const html = renderSidebar(item);
    const label = elementByTestId(html, "task-label");
    expect(label.tag).toBe("span");
    expect(textContent(label.content)).toBe(item.title);
    expect(classes(label.opening)).toEqual(
      expect.arrayContaining(["min-w-0", "flex-1", "truncate"])
    );
    const tooltip = attribute(label.opening, "title");
    expect(tooltip).toContain(item.title);
    expect(tooltip).toContain(item.workspacePath);
    expect(tooltip).toContain(relative);
    expect(tooltip).toContain(
      new Date(item.lastUsedAt ?? item.createdAt).toLocaleString("zh-CN")
    );
    expect(html).not.toContain('data-testid="task-time"');
    expect(html).not.toMatch(/class="[^"]*\bw-14\b/);
  }
);

it.each([false, true])(
  "置顶状态 %s 使用独立图标按钮且名称可访问，已置顶始终可见",
  (pinned) => {
    const html = renderSidebar(task({ pinned }));
    const select = elementByTestId(html, "task-item");
    const pin = elementByTestId(html, "pin-button");
    const label = pinned ? "取消置顶" : "置顶任务";
    expect(pin.tag).toBe("button");
    expect(attribute(pin.opening, "type")).toBe("button");
    expect(attribute(pin.opening, "aria-pressed")).toBe(String(pinned));
    expect(attribute(pin.opening, "aria-label")).toBe(label);
    expect(attribute(pin.opening, "title")).toBe(label);
    expect(pin.content).toContain("<svg");
    expect(select.content).not.toContain('data-testid="pin-button"');
    expect(textContent(select.content)).not.toContain("置顶");
    if (pinned) {
      expect(classes(pin.opening)).not.toEqual(
        expect.arrayContaining(["opacity-0"])
      );
      for (const hiddenClass of [
        "hidden",
        "invisible",
        "pointer-events-none",
      ]) {
        expect(classes(pin.opening)).not.toContain(hiddenClass);
      }
    } else {
      expect(classes(pin.opening)).toContain(
        "group-focus-within/task:opacity-100"
      );
    }
  }
);

it("Worktree 使用图标和读屏标签，保留原路径 tooltip，本地任务不显示该徽标", () => {
  const item = task({
    workspaceMode: "worktree",
    workspacePath: "C:/worktrees/feature",
    workspaceOriginPath: "C:/work/demo",
  });
  const badge = elementByTestId(renderSidebar(item), "worktree-badge");
  expect(attribute(badge.opening, "title")).toBe(
    `托管 Worktree：${item.workspacePath}`
  );
  expect(badge.content).toContain("<svg");
  expectCompactLabel(badge.content, "worktree");
  expect(renderSidebar(task())).not.toContain('data-testid="worktree-badge"');
});

const activityCases: {
  name: string;
  label: string;
  overrides: Partial<TaskListItem>;
}[] = [
  {
    name: "等待优先于运行、失败和未读",
    label: "等待用户",
    overrides: {
      activity: {
        running: true,
        waitingForUser: true,
        outcome: "failed",
        unread: true,
      },
    },
  },
  {
    name: "运行优先于失败和未读",
    label: "运行中",
    overrides: {
      activity: {
        running: true,
        waitingForUser: false,
        outcome: "failed",
        unread: true,
      },
    },
  },
  {
    name: "失败优先于未读",
    label: "失败",
    overrides: {
      activity: {
        running: false,
        waitingForUser: false,
        outcome: "failed",
        unread: true,
      },
    },
  },
  {
    name: "失败已读仍保留结果",
    label: "失败",
    overrides: {
      activity: {
        running: false,
        waitingForUser: false,
        outcome: "failed",
        unread: false,
      },
    },
  },
  {
    name: "中断优先于未读",
    label: "已中断",
    overrides: {
      activity: {
        running: false,
        waitingForUser: false,
        outcome: "interrupted",
        unread: true,
      },
    },
  },
  {
    name: "中断已读仍保留结果",
    label: "已中断",
    overrides: {
      activity: {
        running: false,
        waitingForUser: false,
        outcome: "interrupted",
        unread: false,
      },
    },
  },
  {
    name: "完成未读",
    label: "完成未查看",
    overrides: {
      activity: {
        running: false,
        waitingForUser: false,
        outcome: "completed",
        unread: true,
      },
    },
  },
  {
    name: "旧状态等待输入",
    label: "等待用户",
    overrides: { status: "waiting-user" },
  },
  {
    name: "旧状态等待审批",
    label: "等待用户",
    overrides: { status: "waiting-approval" },
  },
  {
    name: "旧状态流式运行",
    label: "运行中",
    overrides: { status: "streaming" },
  },
];

it.each(activityCases)(
  "活动标签 $name 默认保持文字外观，compact 与侧栏保留同一可访问名称",
  ({ label, overrides }) => {
    const item = task(overrides);
    const normal = renderToStaticMarkup(
      createElement(TaskActivityBadge, { task: item })
    );
    const explicitNormal = renderToStaticMarkup(
      createElement(TaskActivityBadge, { task: item, compact: false })
    );
    expect(explicitNormal).toBe(normal);
    const normalBadge = elementByTestId(normal, "task-activity");
    expect(textContent(normalBadge.content)).toBe(label);
    expect(normalBadge.content).not.toContain("sr-only");
    expect(normalBadge.content).not.toContain("<svg");
    expect(classes(normalBadge.opening)).toEqual(
      expect.arrayContaining(["rounded", "px-1", "py-px", "text-[10px]"])
    );

    const compact = renderToStaticMarkup(
      createElement(TaskActivityBadge, { task: item, compact: true })
    );
    for (const html of [compact, renderSidebar(item)]) {
      const badge = elementByTestId(html, "task-activity");
      expect(attribute(badge.opening, "title")).toBe(label);
      expect(attribute(badge.opening, "aria-label")).toBe(label);
      expectCompactLabel(badge.content, label);
    }
  }
);

it.each([
  { name: "空闲", overrides: {} },
  {
    name: "完成已读",
    overrides: {
      activity: {
        running: false,
        waitingForUser: false,
        outcome: "completed",
        unread: false,
      },
    },
  },
  {
    name: "显式活动状态覆盖旧运行状态",
    overrides: {
      status: "streaming",
      activity: {
        running: false,
        waitingForUser: false,
        outcome: null,
        unread: false,
      },
    },
  },
  {
    name: "显式活动状态覆盖旧等待状态",
    overrides: {
      status: "waiting-user",
      activity: {
        running: false,
        waitingForUser: false,
        outcome: null,
        unread: false,
      },
    },
  },
] satisfies { name: string; overrides: Partial<TaskListItem> }[])(
  "$name 不显示活动标签",
  ({ overrides }) => {
    const item = task(overrides);
    for (const compact of [undefined, false, true]) {
      expect(
        renderToStaticMarkup(
          createElement(TaskActivityBadge, { task: item, compact })
        )
      ).toBe("");
    }
    expect(renderSidebar(item)).not.toContain('data-testid="task-activity"');
  }
);

it("等待用户时侧栏图标保持静态，仅真正运行中转圈（反馈3）", () => {
  // 等待中 activity.running 仍为 true（轮次未结束），等待图标不得转圈
  const waiting = task({
    activity: {
      running: true,
      waitingForUser: true,
      outcome: null,
      unread: false,
    },
  });
  const waitingHtml = renderToStaticMarkup(
    createElement(TaskActivityBadge, { task: waiting, compact: true })
  );
  expect(waitingHtml).not.toContain("animate-spin");
  expect(waitingHtml).toContain('d="M4 3v6m4-6v6"');

  const running = task({
    activity: {
      running: true,
      waitingForUser: false,
      outcome: null,
      unread: false,
    },
  });
  const runningHtml = renderToStaticMarkup(
    createElement(TaskActivityBadge, { task: running, compact: true })
  );
  expect(runningHtml).toContain("animate-spin");
});

it.each([false, true])(
  "原始 HTML 不存在嵌套按钮，包括已归档状态 %s",
  (archived) => {
    const html = renderSidebar(
      task({
        pinned: true,
        archivedAt: archived ? "2026-11-13T10:00:00Z" : null,
        workspaceMode: "worktree",
        activity: {
          running: false,
          waitingForUser: true,
          outcome: null,
          unread: false,
        },
      })
    );
    expect(html).toContain(
      `data-testid="${archived ? "archived-task-item" : "task-item"}"`
    );
    expect(html).toContain('data-testid="pin-button"');
    let buttonDepth = 0;
    for (const match of html.matchAll(/<\/?button\b[^>]*>/g)) {
      if (match[0].startsWith("</")) {
        buttonDepth -= 1;
      } else {
        expect(buttonDepth, `发现嵌套按钮：${match[0]}`).toBe(0);
        buttonDepth += 1;
      }
      expect(buttonDepth).toBeGreaterThanOrEqual(0);
    }
    expect(buttonDepth).toBe(0);
  }
);
