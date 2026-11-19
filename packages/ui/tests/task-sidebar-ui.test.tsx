// @vitest-environment jsdom
import type { TaskListItem } from "@codexlike/desktop/ipc";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskActivityBadge } from "../src/components/TaskActivityBadge";
import { TaskSidebar, clampSidebarWidth } from "../src/components/TaskSidebar";

/** 侧栏交互测试用基础 props（jsdom + @testing-library 直达回调断言） */
function sidebarProps(
  overrides: Partial<Parameters<typeof TaskSidebar>[0]> = {}
): Parameters<typeof TaskSidebar>[0] {
  return {
    projects: [],
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
    searchRecordsRevision: 0,
    ...overrides,
  };
}

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
      searchRecordsRevision: 0,
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
  cleanup();
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
      searchRecordsRevision: 0,
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

it("顶栏图标化：单一「新建任务」按钮（无菜单语义），独立任务组头保留悬停加号", () => {
  const html = renderToStaticMarkup(
    createElement(
      TaskSidebar,
      sidebarProps({
        projects: [
          {
            id: "p1",
            name: "演示项目",
            workspacePath: "/work",
            createdAt: "2026-11-12",
          },
        ],
      })
    )
  );
  // 标题文案与整行按钮移除（原型 prototype/sidebar-buttons 变体 A 定稿）
  expect(html).toContain("任务列表");
  expect(html).not.toContain("+ 新建独立任务");
  // 单一新建入口：图标按钮直达，不再挂 menu 语义（票 03：菜单退役）
  expect(html).toMatch(
    /<button[^>]*data-testid="new-task"[^>]*title="新建任务"/
  );
  expect(html).not.toMatch(
    /<button[^>]*data-testid="new-task"[^>]*aria-haspopup/
  );
  expect(html).not.toMatch(
    /<button[^>]*data-testid="new-task"[^>]*aria-expanded/
  );
  // 多选项菜单容器与菜单项 testid 一并退役
  expect(html).not.toContain('data-testid="new-task-menu"');
  expect(html).not.toContain('data-testid="new-standalone-task-item"');
  expect(html).not.toContain('data-testid="new-project-task-item"');
  expect(html).not.toContain('role="menu"');
  expect(html).not.toContain("新建独立任务</");
  expect(html).not.toContain("在 演示项目 新建任务");
  // 添加项目为图标按钮（aria-label 承担可访问名称）
  expect(html).toMatch(
    /<button[^>]*data-testid="add-project"[^>]*aria-label="添加项目"/
  );
  // 任务搜索迁入头部（ADR 0018）：位于「添加项目」之前的独立图标钮
  const searchPos = html.indexOf('data-testid="task-search-toggle"');
  const addPos = html.indexOf('data-testid="add-project"');
  expect(searchPos).toBeGreaterThan(-1);
  expect(searchPos).toBeLessThan(addPos);
  // 独立任务组头悬停「+」与项目组头同模式
  expect(html).toMatch(
    /<button[^>]*data-testid="standalone-new-task"[^>]*aria-label="新建独立任务"/
  );
  // 移除项目收进项目组头右键菜单，悬停 × 按钮不再存在
  expect(html).not.toContain('data-testid="project-remove"');
  // 两种组头的计数在悬停时都让位隐藏
  expect(
    (html.match(/group-hover\/header:invisible/g) ?? []).length
  ).toBeGreaterThanOrEqual(2);
});

it("顶栏「+」单击直达新建任务入口：不弹菜单，多项目时也无项目选项", () => {
  const onCreate = vi.fn();
  const { container } = render(
    createElement(
      TaskSidebar,
      sidebarProps({
        projects: [
          {
            id: "p1",
            name: "演示项目",
            workspacePath: "/work",
            createdAt: "2026-11-12",
          },
          {
            id: "p2",
            name: "第二个项目",
            workspacePath: "/work2",
            createdAt: "2026-11-12",
          },
        ],
        onCreate,
      })
    )
  );
  const button = screen.getByTestId("new-task");
  expect(button.getAttribute("aria-label")).toBe("新建任务");
  expect(button.getAttribute("title")).toBe("新建任务");
  // 单按钮无 menu 语义（aria-haspopup / aria-expanded 均不存在）
  expect(button.hasAttribute("aria-haspopup")).toBe(false);
  expect(button.hasAttribute("aria-expanded")).toBe(false);
  fireEvent.click(button);
  // 直达：单击即触发新建回调，不弹菜单（含项目存在时也不出项目选项）
  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[data-testid='new-task-menu']")).toBeNull();
  expect(screen.queryByTestId("new-standalone-task-item")).toBeNull();
  expect(screen.queryByTestId("new-project-task-item")).toBeNull();
  expect(container.querySelector("[role='menu']")).toBeNull();
  // 二次点击仍是直达（原菜单形态下二次点击是收起菜单）
  fireEvent.click(button);
  expect(onCreate).toHaveBeenCalledTimes(2);
});

it("组头悬停「+」带语境直达保留：项目组头带项目 id、独立组头走独立入口", () => {
  const onCreate = vi.fn();
  const onCreateInProject = vi.fn();
  render(
    createElement(
      TaskSidebar,
      sidebarProps({
        projects: [
          {
            id: "p1",
            name: "演示项目",
            workspacePath: "/work",
            createdAt: "2026-11-12",
          },
        ],
        onCreate,
        onCreateInProject,
      })
    )
  );
  const projectPlus = screen.getByTestId("project-new-task");
  expect(projectPlus.getAttribute("aria-label")).toBe("在此项目新建任务");
  fireEvent.click(projectPlus);
  expect(onCreateInProject).toHaveBeenCalledWith("p1");
  expect(onCreate).not.toHaveBeenCalled();
  const standalonePlus = screen.getByTestId("standalone-new-task");
  expect(standalonePlus.getAttribute("aria-label")).toBe("新建独立任务");
  fireEvent.click(standalonePlus);
  expect(onCreate).toHaveBeenCalledTimes(1);
});

it("空侧栏空态文案指向单一新建任务入口，不再罗列独立 / 项目", () => {
  const html = renderToStaticMarkup(createElement(TaskSidebar, sidebarProps()));
  // groups 恒含独立分区（project-groups：独立组始终保留），
  // 空态分支实际不可达；其引导文案仍与新入口同步（防未来复用误导）。
  expect(html).not.toContain("独立 / 项目");
  // 真实可见行为：空数据显示独立组头，顶栏单一「新建任务」按钮在场
  expect(html).toContain('data-testid="standalone-header"');
  expect(html).toMatch(
    /<button[^>]*data-testid="new-task"[^>]*title="新建任务"/
  );
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
    name: "排队中（任务并发上限票 03）",
    label: "排队中",
    overrides: {
      activity: {
        running: false,
        waitingForUser: false,
        outcome: null,
        unread: false,
        queued: true,
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
    name: "中断未读提醒（查看后熄灭，2026-11-19 口径）",
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
    // 中断是用户主动停止的未读提醒（与「完成未查看」同口径）：查看过后
    // 不再显示；失败仍是结果性状态常显（见上方「失败已读仍保留结果」）
    name: "中断已读不再提醒",
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

it("排队中徽章静态时钟弱于运行中转圈、强于无状态（任务并发上限票 03）", () => {
  const queued = task({
    activity: {
      running: false,
      waitingForUser: false,
      outcome: null,
      unread: false,
      queued: true,
    },
  });
  const html = renderToStaticMarkup(
    createElement(TaskActivityBadge, { task: queued, compact: true })
  );
  // 静态时钟：不转圈、非 accent 蓝，muted 色弱于运行中
  expect(html).not.toContain("animate-spin");
  expect(html).not.toContain("text-accent");
  expect(html).toContain("text-fg-muted");
  // 时钟图标（圆盘 + 指针），尺寸为非运行中的小档
  expect(html).toMatch(/width="10"/);
  expect(html).toContain('cx="6" cy="6" r="3.5"');

  // 开跑后（queued 撤销、running 接管）：切回运行中样式（转圈 accent）
  const started = task({
    activity: {
      running: true,
      waitingForUser: false,
      outcome: null,
      unread: false,
      queued: false,
    },
  });
  const startedHtml = renderToStaticMarkup(
    createElement(TaskActivityBadge, { task: started, compact: true })
  );
  expect(startedHtml).toContain("animate-spin");
  expect(startedHtml).toContain("text-accent");
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

describe("clampSidebarWidth（左栏宽度双端夹取，右栏 clampRailWidth 同款）", () => {
  it("下限 240、上限 max 生效，上限优先于下限", () => {
    expect(clampSidebarWidth(100, 640)).toBe(240);
    expect(clampSidebarWidth(240, 640)).toBe(240);
    expect(clampSidebarWidth(320, 640)).toBe(320);
    expect(clampSidebarWidth(9999, 640)).toBe(640);
    // 上限低于下限（正文被压到最小宽）：上限优先，跟随容器收窄
    expect(clampSidebarWidth(240, 100)).toBe(100);
  });
});

it("侧栏右缘拖拽分隔条：separator 语义 + 可聚焦，aside 默认 320px（原 w-80）", () => {
  const html = renderSidebar(task());
  // 分隔条：separator 语义 + 可聚焦（键盘微调入口，右栏同款）
  expect(html).toMatch(
    /<div[^>]*role="separator"[^>]*aria-label="调整任务列表宽度"/
  );
  expect(html).toMatch(/data-testid="sidebar-separator"[^>]*tabindex="0"/);
  // aside 默认宽 320px：与原 w-80 一致（e2e sidebar-archive 断言同值）
  expect(html).toMatch(/<aside[^>]*style="width:320px"/);
});

it("置顶图标列在任务标题之前（2026-11-19 前置）：pin-button 先于 task-item 出现", () => {
  const html = renderSidebar(task({ pinned: true }));
  const pinIndex = html.indexOf('data-testid="pin-button"');
  const selectIndex = html.indexOf('data-testid="task-item"');
  expect(pinIndex).toBeGreaterThan(-1);
  expect(pinIndex).toBeLessThan(selectIndex);
});

/** 组内活跃任务预览限额测试数据：n 越小越新（lastUsedAt 递减，顺序稳定） */
function stackedTasks(count: number, projectId: string | null = null) {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return task({
      id: `t${n}`,
      projectId,
      title: `堆叠任务${n}`,
      lastUsedAt: `2026-11-13T10:0${count - n}:00Z`,
    });
  });
}

describe("组内活跃任务默认 5 条，「更多」展开（预览限额与队列条同口径）", () => {
  it("默认仅渲染前 5 条并带「更多（N）」；恰好 5 条时无按钮", () => {
    const html = renderToStaticMarkup(
      createElement(TaskSidebar, sidebarProps({ tasks: stackedTasks(7) }))
    );
    const rows = html.match(/data-testid="task-row" data-task-id="t\d"/g) ?? [];
    expect(rows).toHaveLength(5);
    expect(html).not.toContain('data-task-id="t6"');
    expect(html).not.toContain('data-task-id="t7"');
    const more = elementByTestId(html, "toggle-more-tasks");
    expect(textContent(more.content)).toBe("更多（2）");
    // 恰好 5 条：全量渲染、无展开入口
    const fiveHtml = renderToStaticMarkup(
      createElement(TaskSidebar, sidebarProps({ tasks: stackedTasks(5) }))
    );
    expect(
      (fiveHtml.match(/data-testid="task-row" data-task-id="t\d"/g) ?? [])
        .length
    ).toBe(5);
    expect(fiveHtml).not.toContain('data-testid="toggle-more-tasks"');
  });

  it("点击「更多」展开全部并变「收起」，再点回到前 5 条", () => {
    render(
      createElement(TaskSidebar, sidebarProps({ tasks: stackedTasks(7) }))
    );
    const rows = () => screen.getAllByTestId("task-row");
    expect(rows()).toHaveLength(5);
    fireEvent.click(screen.getByTestId("toggle-more-tasks"));
    expect(rows()).toHaveLength(7);
    expect(screen.getByTestId("toggle-more-tasks").textContent).toBe("收起");
    fireEvent.click(screen.getByTestId("toggle-more-tasks"));
    expect(rows()).toHaveLength(5);
    expect(screen.getByTestId("toggle-more-tasks").textContent).toBe(
      "更多（2）"
    );
  });

  it("当前任务被截断时自动展开全量（与归档子折叠同口径：折叠不隐藏当前查看）", () => {
    const html = renderToStaticMarkup(
      createElement(
        TaskSidebar,
        sidebarProps({ tasks: stackedTasks(7), currentId: "t7" })
      )
    );
    expect(
      (html.match(/data-testid="task-row" data-task-id="t\d"/g) ?? []).length
    ).toBe(7);
    expect(html).toContain('data-task-id="t7"');
  });

  it("项目组与独立组各自计限额：各渲染前 5 条、各带独立「更多」", () => {
    const html = renderToStaticMarkup(
      createElement(
        TaskSidebar,
        sidebarProps({
          projects: [
            {
              id: "p1",
              name: "堆叠项目",
              workspacePath: "/work",
              createdAt: "2026-11-12",
            },
          ],
          tasks: [
            ...stackedTasks(6, "p1"),
            ...stackedTasks(6).map((item, index) => ({
              ...item,
              id: `s${index + 1}`,
            })),
          ],
        })
      )
    );
    expect(
      (html.match(/data-testid="task-row" data-task-id="t\d"/g) ?? []).length
    ).toBe(5);
    expect(
      (html.match(/data-testid="task-row" data-task-id="s\d"/g) ?? []).length
    ).toBe(5);
    expect((html.match(/data-testid="toggle-more-tasks"/g) ?? []).length).toBe(
      2
    );
  });
});
