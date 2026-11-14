/**
 * dev 浏览器预览设施的静态样例数据（dev/browser-stub.ts 的读返回值）。
 * 手造样例、无持久化——形状与 IPC 契约一致（TaskListItem / TaskView /
 * TranscriptItem 等），让真实组件渲染出「有任务的完整工作台」。
 * 仅 dev 预览使用，生产构建不含（随 browser-stub.ts 动态引入）。
 */
import type {
  InteractionRecord,
  ProjectRecord,
  ProviderProfile,
  StoredMessage,
  TaskResourcesView,
  ToolCallRecord,
} from "@codexlike/agent-core";
import type { TaskListItem, TaskView } from "@codexlike/desktop/ipc";

const T0 = "2026-11-13T09:12:00.000Z";
const T1 = "2026-11-13T09:13:30.000Z";
const T2 = "2026-11-13T09:14:10.000Z";
const T3 = "2026-11-13T09:15:02.000Z";

export const PROJECTS: ProjectRecord[] = [
  {
    id: "proj-1",
    name: "ai-agent",
    workspacePath: "C:\\Users\\leffss\\Desktop\\ai-agent",
    createdAt: T0,
  },
  {
    id: "proj-2",
    name: "docs-site",
    workspacePath: "D:\\work\\docs-site",
    createdAt: T0,
  },
];

export const PROFILES: ProviderProfile[] = [
  {
    id: "prof-1",
    name: "GLM",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    apiKey: "sk-sample",
    model: "glm-4.7",
    contextWindowTokens: 200000,
  },
  {
    id: "prof-2",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-sample",
    model: "deepseek-chat",
    contextWindowTokens: 128000,
  },
];

export const WORKSPACE_FILES: string[] = [
  "packages/ui/src/pages/WorkspacePage.tsx",
  "packages/ui/src/App.tsx",
  "packages/ui/src/styles.css",
  "docs/adr/0006-semantic-theme-tokens.md",
];

/** 主样例任务：围绕「重构主窗口布局」组织消息流文案，贴近本次原型语境。 */
export const MAIN_TASK_ID = "task-1";

export const TASKS: TaskListItem[] = [
  {
    id: MAIN_TASK_ID,
    projectId: "proj-1",
    title: "重构主窗口布局",
    workspacePath: "C:\\Users\\leffss\\.codexlike\\worktrees\\task-1",
    workspaceMode: "worktree",
    workspaceOriginPath: "C:\\Users\\leffss\\Desktop\\ai-agent",
    providerProfileId: "prof-1",
    model: "glm-4.7",
    approvalMode: "assist",
    status: "idle",
    archivedAt: null,
    createdAt: T0,
    lastUsedAt: T3,
    updatedAt: T3,
    activity: {
      running: false,
      waitingForUser: false,
      outcome: "completed",
      unread: false,
    },
  },
  {
    id: "task-2",
    projectId: "proj-1",
    title: "修复 e2e 剪贴板断言",
    workspacePath: "C:\\Users\\leffss\\Desktop\\ai-agent",
    workspaceMode: "local",
    workspaceOriginPath: null,
    providerProfileId: "prof-1",
    model: "glm-4.7",
    approvalMode: "assist",
    status: "idle",
    archivedAt: null,
    createdAt: T0,
    lastUsedAt: T2,
    updatedAt: T2,
    activity: {
      running: false,
      waitingForUser: false,
      outcome: "completed",
      unread: false,
    },
  },
  {
    id: "task-3",
    projectId: null,
    title: "编写数据库迁移脚本",
    workspacePath: "C:\\Users\\leffss\\.codexlike\\tasks\\task-3",
    workspaceMode: "local",
    workspaceOriginPath: null,
    providerProfileId: "prof-2",
    model: "deepseek-chat",
    approvalMode: "assist",
    status: "streaming",
    archivedAt: null,
    createdAt: T0,
    lastUsedAt: T3,
    updatedAt: T3,
    activity: {
      running: true,
      waitingForUser: false,
      outcome: null,
      unread: true,
    },
  },
  {
    id: "task-4",
    projectId: "proj-2",
    title: "整理 ADR 目录",
    workspacePath: "D:\\work\\docs-site",
    workspaceMode: "local",
    workspaceOriginPath: null,
    providerProfileId: "prof-1",
    model: "glm-4.7",
    approvalMode: "ask",
    status: "waiting-user",
    archivedAt: null,
    createdAt: T0,
    lastUsedAt: T1,
    updatedAt: T1,
    activity: {
      running: false,
      waitingForUser: true,
      outcome: null,
      unread: true,
    },
  },
  {
    id: "task-5",
    projectId: "proj-2",
    title: "发布流程自动化",
    workspacePath: "D:\\work\\docs-site",
    workspaceMode: "local",
    workspaceOriginPath: null,
    providerProfileId: "prof-2",
    model: "deepseek-chat",
    approvalMode: "assist",
    status: "idle",
    archivedAt: null,
    createdAt: T0,
    lastUsedAt: T1,
    updatedAt: T1,
    activity: {
      running: false,
      waitingForUser: false,
      outcome: "completed",
      unread: false,
    },
  },
];

function userMessage(
  id: string,
  content: string,
  createdAt: string
): StoredMessage {
  return { id, taskId: MAIN_TASK_ID, role: "user", content, createdAt };
}

function assistantMessage(
  id: string,
  content: string,
  createdAt: string,
  reasoning?: string
): StoredMessage {
  return {
    id,
    taskId: MAIN_TASK_ID,
    role: "assistant",
    content,
    reasoning,
    createdAt,
  };
}

function toolCall(
  id: string,
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  createdAt: string
): ToolCallRecord {
  return {
    id,
    taskId: MAIN_TASK_ID,
    toolName,
    arguments: JSON.stringify(args),
    output,
    isError: false,
    createdAt,
  };
}

const APPROVAL_INTERACTION: InteractionRecord = {
  request: {
    id: "int-1",
    taskId: MAIN_TASK_ID,
    turnId: "int-1",
    toolCallId: "tc-3",
    source: { kind: "main" },
    createdAt: T2,
    kind: "approval",
    toolName: "run_terminal_command",
    command: "pnpm --filter @codexlike/ui run test",
    commandWord: "pnpm",
  },
  status: "resolved",
  response: { kind: "approval", decision: "approve" },
  resolvedAt: T3,
  cancelReason: null,
};

const MAIN_HISTORY = [
  {
    kind: "message" as const,
    message: userMessage(
      "msg-u1",
      "主界面纵向太挤了：标题栏一整行只放了品牌名，workspace-info 又占一整行就一条路径，消息流上方还可能同时堆 5 条警告条。请先给一版空间利用率更高的布局方案：标题栏改成任务上下文行，workspace-info 缩成徽章。",
      T0
    ),
  },
  {
    kind: "message" as const,
    message: assistantMessage(
      "msg-a1",
      "",
      T1,
      "用户想压缩纵向空间。盘点现状分区：标题栏 / 任务头行 / workspace-info / 最多 5 条警告条 / composer。逐项决定去向——标题栏承载任务名与路径摘要；workspace-info 缩成标题栏徽章；警告条合并为单条可展开状态条。先读布局代码确认结构再出方案。"
    ),
  },
  {
    kind: "tool-call" as const,
    call: toolCall(
      "tc-1",
      "read_file",
      { path: "packages/ui/src/pages/WorkspacePage.tsx" },
      '…（1578 行，节选）<header data-testid="window-titlebar"> … <section className="@container/task">',
      T1
    ),
  },
  {
    kind: "tool-call" as const,
    call: toolCall(
      "tc-2",
      "grep",
      { pattern: "workspace-info", path: "packages/ui/src" },
      "WorkspacePage.tsx:1263  WorkspacePage.tsx:1269",
      T1
    ),
  },
  {
    kind: "message" as const,
    message: assistantMessage(
      "msg-a2",
      "现状确认完毕，布局方案要点如下：\n\n1. **标题栏 → 任务上下文行**：左侧「任务名 › 项目 › worktree 徽章」面包屑，右侧全局搜索 + 主题/设置/窗口控制；无任务时退回品牌展示。\n2. **workspace-info 整行取消**：路径摘要缩进标题栏徽章，完整路径与目录选择移入点击弹层。\n3. **警告条收纳**：保存错误 / profile 不可用 / 上下文告警 / 共享提示 / 自动批准状态合并为单条状态胶囊，多条时计数展开。\n4. **右栏 tab 化**：「规范与技能」「改动」共享一个 rail，tab 切换不再叠加抢高度。",
      T1
    ),
  },
  { kind: "interaction" as const, interaction: APPROVAL_INTERACTION },
  {
    kind: "message" as const,
    message: assistantMessage(
      "msg-a3",
      "测试全绿（41 passed）。方案已按上述四点整理成布局变体，请翻看 `?variant=` 原型逐个对比，挑选或混搭。",
      T3
    ),
  },
  {
    kind: "message" as const,
    message: userMessage(
      "msg-u2",
      "右栏两个面板叠着抢高度，改成 tab 切换；改动面板默认收起。",
      T3
    ),
  },
  {
    kind: "message" as const,
    message: assistantMessage(
      "msg-a4",
      "收到，变体 B 的抽屉方案里会把两个面板做成同一容器内的 tab 切换，默认只显示把手。",
      T3
    ),
  },
];

function simpleHistory(title: string): TranscriptShape[] {
  return [
    {
      kind: "message" as const,
      message: userMessage(`msg-${title}`, `帮我处理：${title}。`, T0),
    },
    {
      kind: "message" as const,
      message: assistantMessage(
        `msg-a-${title}`,
        "已完成。改动摘要已写入对应文件，测试通过。",
        T1
      ),
    },
  ];
}

type TranscriptShape = { kind: "message"; message: StoredMessage };

/** 按 taskId 返回样例 TaskView：主任务完整，其余简短。 */
export function taskView(taskId: string): TaskView | null {
  if (!TASKS.some((task) => task.id === taskId)) return null;
  const task = TASKS.find((item) => item.id === taskId)!;
  const history =
    taskId === MAIN_TASK_ID ? MAIN_HISTORY : simpleHistory(task.title);
  return {
    taskId,
    autoApprove: false,
    executionId: "exec-1",
    sequence: 24,
    history,
    events: [],
    pendingInteractions: [],
    activity: task.activity ?? {
      running: false,
      waitingForUser: false,
      outcome: "completed",
      unread: false,
    },
    queueState: { queue: [], paused: false, sendingId: null },
  };
}

export const RESOURCES: TaskResourcesView = {
  active: null,
  last: null,
  preview: {
    catalog: {
      capturedAt: T0,
      agents: {
        sources: [
          {
            path: "AGENTS.md",
            scope: "project",
            bytes: 1820,
            includedBytes: 1820,
          },
        ],
        truncated: false,
      },
      skills: [
        {
          name: "tdd",
          description: "Test-driven development: red-green-refactor slices.",
          path: ".zcode/skills/tdd/SKILL.md",
          directory: ".zcode/skills/tdd",
          scope: "project",
          source: "codexlike",
          status: "active",
        },
        {
          name: "code-review",
          description: "Two-axis review: standards + spec compliance.",
          path: ".zcode/skills/code-review/SKILL.md",
          directory: ".zcode/skills/code-review",
          scope: "project",
          source: "codexlike",
          status: "active",
        },
      ],
      diagnostics: [],
      indexBytes: 2400,
    },
    loaded: [
      {
        executorId: "exec-1",
        name: "tdd",
        path: ".zcode/skills/tdd/SKILL.md",
        kind: "skill",
        bytes: 3200,
      },
    ],
    estimatedTokens: 850,
  },
};
