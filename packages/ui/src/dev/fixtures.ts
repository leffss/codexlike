/**
 * dev 浏览器预览设施的静态样例数据（dev/browser-stub.ts 的读返回值）。
 * 手造样例、无持久化——形状与 IPC 契约一致（TaskListItem / TaskView /
 * TranscriptItem 等），让真实组件渲染出「有任务的完整工作台」。
 * 仅 dev 预览使用，生产构建不含（随 browser-stub.ts 动态引入）。
 */
import type {
  GitStatus,
  InteractionRecord,
  ProjectRecord,
  ProviderProfile,
  StoredMessage,
  SubagentSnapshot,
  TaskResourcesView,
  ToolCallRecord,
} from "@codexlike/agent-core";
import type {
  TaskEventEnvelope,
  TaskListItem,
  TaskView,
} from "@codexlike/desktop/ipc";

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

/**
 * 右栏「改动」tab 的 git 样例（ADR 0018 折叠后 dev 预览用）：混合
 * 变更类型给足密度；diff 走单文件新旧全文。
 */
export const GIT_STATUS: GitStatus = {
  isGitRepo: true,
  branch: "main",
  files: [
    { path: "packages/ui/src/pages/WorkspacePage.tsx", kind: "modified" },
    { path: "packages/ui/src/components/RailPanel.tsx", kind: "added" },
    { path: "packages/ui/src/components/GitActions.tsx", kind: "added" },
    {
      path: "docs/agents/panels.md",
      kind: "renamed",
      oldPath: "docs/agents/drawer.md",
    },
    { path: "packages/ui/src/components/PanelsDrawer.tsx", kind: "deleted" },
  ],
};

export const GIT_DIFFS: Record<string, { original: string; modified: string }> =
  {
    "packages/ui/src/pages/WorkspacePage.tsx": {
      original: [
        "import { PanelsDrawer, type DrawerTab } from '../components/PanelsDrawer';",
        "",
        "export function WorkspacePage(props) {",
        "  const [drawer, setDrawer] = useState<DrawerTab | null>(null);",
        "  return (",
        "    <div className='flex min-h-0 flex-1 flex-col'>",
        "      <MessageStream items={items} />",
        "      {drawer !== null && (",
        "        <PanelsDrawer tab={drawer} onClose={closeDrawer} />",
        "      )}",
        "    </div>",
        "  );",
        "}",
      ].join("\n"),
      modified: [
        "import { RailPanel } from '../components/RailPanel';",
        "",
        "export function WorkspacePage(props) {",
        "  const [railOpen, setRailOpen] = useState(false);",
        "  return (",
        "    <div className='flex min-h-0 flex-1'>",
        "      <MessageStream items={items} />",
        "      <RailPanel",
        "        open={railOpen}",
        "        taskId={currentId}",
        "        onChangesCount={setChangesCount}",
        "      />",
        "    </div>",
        "  );",
        "}",
      ].join("\n"),
    },
  };

/** 未命中 GIT_DIFFS 的路径给一段通用样例（点任何文件都有 diff 可看） */
export function gitDiffFor(path: string): {
  original: string;
  modified: string;
} {
  const hit = GIT_DIFFS[path];
  if (hit !== undefined) return hit;
  return {
    original: `// HEAD 版本（新文件为空串）：${path}\nexport function sample() {\n  return null;\n}\n`,
    modified: `// 工作区当前内容（已删除为空串）：${path}\nexport function sample() {\n  return 'preview';\n}\n`,
  };
}

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
    // 主任务展示「已开启自动批准」提示卡（正文与输入区之间）的样例状态
    autoApprove: true,
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

/**
 * 子代理样例事件（工单 13 事件形状）：sub-live-1 运行中（排队→开跑→
 * 读文件完成→grep 进行中→思考流）；sub-live-2 已完成（事件全链走完，
 * 带嵌套工具清单与报告——恢复态 history 记录重建的完成卡没有工具
 * 清单，这里补齐该形态）。右栏「子代理」tab（ADR 0020）消费。
 */
function subEnvelope(
  sequence: number,
  event: TaskEventEnvelope["event"]
): TaskEventEnvelope {
  return {
    taskId: MAIN_TASK_ID,
    executionId: "exec-1",
    sequence,
    event,
    activity: {
      running: true,
      waitingForUser: false,
      outcome: null,
      unread: false,
    },
  };
}

const SUBAGENT_EVENTS: TaskEventEnvelope[] = [
  subEnvelope(1, {
    type: "subagent-queued",
    subagentId: "sub-live-1",
    task: "梳理 MessageStream 段渲染分派与折叠记忆约定",
  }),
  subEnvelope(2, {
    type: "subagent-start",
    subagentId: "sub-live-1",
    task: "梳理 MessageStream 段渲染分派与折叠记忆约定",
    toolCallId: "tc-sub-live-1",
  }),
  subEnvelope(3, {
    type: "subagent-tool",
    subagentId: "sub-live-1",
    phase: "call",
    call: toolCall(
      "tc-sub1-rf",
      "read_file",
      { path: "packages/ui/src/components/MessageStream.tsx" },
      "",
      T3
    ),
  }),
  subEnvelope(4, {
    type: "subagent-tool",
    subagentId: "sub-live-1",
    phase: "result",
    call: toolCall(
      "tc-sub1-rf",
      "read_file",
      { path: "packages/ui/src/components/MessageStream.tsx" },
      '…（617 行，节选）function SegmentView(props) { if (segment.kind === "subagent") return <SubagentStreamMarker subagent={segment} />; … }',
      T3
    ),
  }),
  subEnvelope(5, {
    type: "subagent-tool",
    subagentId: "sub-live-1",
    phase: "call",
    call: toolCall(
      "tc-sub1-gr",
      "grep",
      { pattern: "useCollapseState", path: "packages/ui/src/components" },
      "",
      T3
    ),
  }),
  subEnvelope(6, {
    type: "subagent-reasoning",
    subagentId: "sub-live-1",
    delta:
      "折叠记忆统一用任务作用域键前缀 subagent-，切换任务不丢。继续查 grep 结果。",
  }),
  // 正文流式增量（票 04「正文」折叠块）：逐轮出现，与思考折叠同构
  subEnvelope(7, {
    type: "subagent-text-delta",
    subagentId: "sub-live-1",
    delta: "第一轮先汇报阶段性结论：SegmentView 按 kind 分派，",
  }),
  subEnvelope(8, {
    type: "subagent-text-delta",
    subagentId: "sub-live-1",
    delta: "subagent 段的正文全部收纳右栏，主序列只留标记行。",
  }),
  subEnvelope(9, {
    type: "subagent-reasoning",
    subagentId: "sub-live-1",
    delta:
      "折叠记忆统一用任务作用域键前缀 subagent-，切换任务不丢。继续查 grep 结果。",
  }),
  subEnvelope(10, {
    type: "subagent-start",
    subagentId: "sub-live-2",
    task: "盘点布局相关 e2e 断言清单",
    toolCallId: "tc-sub-live-2",
  }),
  subEnvelope(11, {
    type: "subagent-tool",
    subagentId: "sub-live-2",
    phase: "call",
    call: toolCall(
      "tc-sub2-gr",
      "grep",
      { pattern: "rail-panel", path: "e2e" },
      "",
      T3
    ),
  }),
  subEnvelope(12, {
    type: "subagent-tool",
    subagentId: "sub-live-2",
    phase: "result",
    call: toolCall(
      "tc-sub2-gr",
      "grep",
      { pattern: "rail-panel", path: "e2e" },
      "width-tiers.spec.ts:41  acceptance.spec.ts:88  changes.spec.ts:12",
      T3
    ),
  }),
  subEnvelope(13, {
    type: "subagent-reasoning",
    subagentId: "sub-live-2",
    delta:
      "布局几何断言集中在 width-tiers 与 acceptance 两个 spec，共 3 处直接引用 rail-panel。",
  }),
  subEnvelope(14, {
    type: "subagent-report",
    subagentId: "sub-live-2",
    task: "盘点布局相关 e2e 断言清单",
    report: [
      "布局相关 e2e 断言共 3 处直接依赖右栏 `rail-panel` testid：",
      "",
      "- `width-tiers.spec.ts:41`——右栏推窄几何（400 默认宽 + 行宽夹取）",
      "- `acceptance.spec.ts:88`——tab 互斥与开关状态同步",
      "- `changes.spec.ts:12`——文件清单与 diff 路径行",
      "",
      "消息流 480 保底断言不直接引用右栏节点，改动消息流内子代理呈现不会影响它。",
    ].join("\n"),
    ok: true,
  }),
];

/**
 * 子代理恢复快照样例（票 04，ADR 0021 恢复新路径）：与 MAIN_HISTORY 的
 * spawn 行按委派说明匹配——sub-rec-1 命中 tc-sub-r3（瘦身后新记录：行只带
 * 报告，过程由快照三表重建）；sub-rec-2 无行（运行中被杀：行随轮末回填、
 * 未落），恢复时按委派时点插回时间线留痕（interrupted 态；本样例委派时点
 * 与时间线末尾同刻，位置仍在末尾）。tc-sub-r1 / tc-sub-r2
 * 是本特性前的旧记录（无快照），照旧走 subagentFromToolRecord 反推路径。
 */
const SUBAGENT_TASK_R3 = "梳理右栏 tab 化的宽度断言链";

const SUBAGENTS: SubagentSnapshot[] = [
  {
    record: {
      id: "sub-rec-1",
      taskId: MAIN_TASK_ID,
      task: SUBAGENT_TASK_R3,
      status: "completed",
      queuedAt: T2,
      startedAt: T2,
      completedAt: T3,
    },
    messages: [
      {
        id: "sm-r3-1",
        taskId: MAIN_TASK_ID,
        subagentId: "sub-rec-1",
        content:
          "第一轮：先确认 width-tiers 的三档断言与 rail-separator 的拖拽边界。",
        reasoning: "宽度断言分散在 e2e 与 clampRailWidth 两处，先收集再归纳。",
        createdAt: T2,
      },
      {
        id: "sm-r3-2",
        taskId: MAIN_TASK_ID,
        subagentId: "sub-rec-1",
        content: [
          "宽度断言链梳理结论：",
          "",
          "1. `clampRailWidth` 纯函数夹取 320–640，单元测试直测；",
          "2. `width-tiers.mjs` 走真实窗口三档几何（默认 400 / 拖宽 640 / 收窄 320）；",
          "3. tab 化后新增 tab 互斥断言依赖 `rail-tab-*` testid，与宽度链正交。",
        ].join("\n"),
        createdAt: T3,
      },
    ],
    toolCalls: [
      {
        id: "st-r3-1",
        taskId: MAIN_TASK_ID,
        subagentId: "sub-rec-1",
        toolName: "grep",
        arguments: '{"pattern":"clampRailWidth","path":"packages/ui"}',
        output: "RailPanel.tsx:42  rail-panel-ui.test.tsx:61",
        isError: false,
        createdAt: T2,
      },
      {
        id: "st-r3-2",
        taskId: MAIN_TASK_ID,
        subagentId: "sub-rec-1",
        toolName: "read_file",
        arguments: '{"path":"packages/desktop/e2e/width-tiers.mjs"}',
        output: "…（约 120 行）三档断言：默认 400、拖宽夹 640、收窄夹 320…",
        isError: false,
        createdAt: T2,
      },
    ],
  },
  {
    record: {
      id: "sub-rec-2",
      taskId: MAIN_TASK_ID,
      task: "压缩后回归验证消息流宽度",
      status: "interrupted",
      queuedAt: T3,
      startedAt: T3,
      completedAt: T3,
    },
    messages: [
      {
        id: "sm-r4-1",
        taskId: MAIN_TASK_ID,
        subagentId: "sub-rec-2",
        content: "中断前已确认消息流内容宽随容器 tier 收窄，断言用",
        reasoning: "先复跑 width-tiers 再看 compact 后的消息流宽度是否有回归。",
        createdAt: T3,
      },
    ],
    toolCalls: [
      {
        id: "st-r4-1",
        taskId: MAIN_TASK_ID,
        subagentId: "sub-rec-2",
        toolName: "glob",
        arguments: '{"pattern":"packages/desktop/e2e/*.mjs"}',
        output: "width-tiers.mjs  changes.mjs  …",
        isError: false,
        createdAt: T3,
      },
    ],
  },
];

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
      "用户想压缩纵向空间。盘点现状分区：标题栏 / 任务头行 / workspace-info / 最多 5 条警告条 / composer。逐项决定去向——标题栏承载任务名与路径摘要；workspace-info 缩成标题栏徽章；警告条合并为单条可展开状态条。先列工作计划，再读布局代码确认结构。"
    ),
  },
  /* 工作计划样例（ADR 0016）：第 1 版建清单，步骤 1 进行中 */
  {
    kind: "tool-call" as const,
    call: toolCall(
      "tc-plan-1",
      "update_plan",
      {
        steps: [
          {
            content: "调研现有布局代码（WorkspacePage/标题栏/警告条）",
            status: "in_progress",
          },
          { content: "梳理分区与警告条现状清单", status: "pending" },
          { content: "标题栏改任务上下文行方案", status: "pending" },
          { content: "workspace-info 缩为标题栏徽章", status: "pending" },
          { content: "警告条合并为单条状态胶囊", status: "pending" },
          { content: "右栏两面板改 tab 切换", status: "pending" },
          { content: "布局变体原型与回归测试", status: "pending" },
        ],
      },
      "工作计划已更新（共 7 项：0 已完成、1 进行中、6 待办）",
      T1
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
  /* 子代理样例：恢复态完成记录——
     subagentFromToolRecord 重建（task 取 arguments.task、报告即 output） */
  {
    kind: "tool-call" as const,
    call: {
      ...toolCall(
        "tc-sub-r1",
        "spawn_subagent",
        { task: "调研 WorkspacePage 分区结构与警告条实现" },
        [
          "## 分区结构调研结论",
          "",
          "中列自上而下共 5 层，纵向占用问题集中在上面 3 层：",
          "",
          "1. **标题栏**：`window-titlebar` 一整行仅放品牌名与窗口控制，左 60% 空间闲置；",
          "2. **任务头行 + workspace-info**：两行合计 ~96px，任务名与路径摘要可合并进标题栏；",
          "3. **警告条区**：最多 5 条（保存错误 / profile 不可用 / 上下文告警 / 共享提示 / 自动批准状态）同时堆叠，票03 已改右下角浮层；",
          "4. **消息流**：`flex-1` 主区，内容宽度由 `contentWidthClass` 约束；",
          "5. **输入区 / 交互面板**：与消息列同宽（票05 不变量）。",
          "",
          "建议：标题栏改任务上下文行（面包屑：任务名 › 项目 › worktree 徽章），",
          "workspace-info 缩为徽章，5 类提示走 `ToastHost` 浮层不占布局行。",
        ].join("\n"),
        T1
      ),
      reasoning:
        "用户反馈纵向太挤。先读 WorkspacePage 主结构确认分区，再逐项判断哪些可以合并或下沉。警告条已有浮层方案（票03），剩下标题栏与 workspace-info 是主要压缩点。",
    },
  },
  /* 工作计划样例：第 2 版，调研收官进入方案设计 */
  {
    kind: "tool-call" as const,
    call: toolCall(
      "tc-plan-2",
      "update_plan",
      {
        steps: [
          {
            content: "调研现有布局代码（WorkspacePage/标题栏/警告条）",
            status: "completed",
          },
          { content: "梳理分区与警告条现状清单", status: "completed" },
          { content: "标题栏改任务上下文行方案", status: "in_progress" },
          { content: "workspace-info 缩为标题栏徽章", status: "pending" },
          { content: "警告条合并为单条状态胶囊", status: "pending" },
          { content: "右栏两面板改 tab 切换", status: "pending" },
          { content: "布局变体原型与回归测试", status: "pending" },
        ],
      },
      "工作计划已更新（共 7 项：2 已完成、1 进行中、4 待办）",
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
  /* 子代理样例：失败委派（ok=false，报告为中文失败原因） */
  {
    kind: "tool-call" as const,
    call: toolCall(
      "tc-sub-r2",
      "spawn_subagent",
      { task: "盘点旧布局的 e2e 断言依赖" },
      "子代理执行失败：模型 API 返回 429 Too Many Requests（已按指数退避重试 2 次），本轮委派未完成，可重新发起。",
      T2
    ),
  },
  /* 子代理样例：瘦身后新记录（票 04 contract 步）——行只带最终报告
     （无 reasoning 拼接），逐轮过程由 SUBAGENTS 快照 sub-rec-1 重建 */
  {
    kind: "tool-call" as const,
    call: toolCall(
      "tc-sub-r3",
      "spawn_subagent",
      { task: SUBAGENT_TASK_R3 },
      [
        "宽度断言链梳理结论：",
        "",
        "1. `clampRailWidth` 纯函数夹取 320–640，单元测试直测；",
        "2. `width-tiers.mjs` 走真实窗口三档几何（默认 400 / 拖宽 640 / 收窄 320）；",
        "3. tab 化后新增 tab 互斥断言依赖 `rail-tab-*` testid，与宽度链正交。",
      ].join("\n"),
      T3
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
  /* 工作计划样例：第 3 版（第二轮），前三项收官进入右栏 tab 化 */
  {
    kind: "tool-call" as const,
    call: toolCall(
      "tc-plan-3",
      "update_plan",
      {
        steps: [
          {
            content: "调研现有布局代码（WorkspacePage/标题栏/警告条）",
            status: "completed",
          },
          { content: "梳理分区与警告条现状清单", status: "completed" },
          { content: "标题栏改任务上下文行方案", status: "completed" },
          { content: "workspace-info 缩为标题栏徽章", status: "completed" },
          { content: "警告条合并为单条状态胶囊", status: "completed" },
          { content: "右栏两面板改 tab 切换", status: "in_progress" },
          { content: "布局变体原型与回归测试", status: "pending" },
        ],
      },
      "工作计划已更新（共 7 项：5 已完成、1 进行中、1 待办）",
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
    autoApprove: taskId === MAIN_TASK_ID,
    executionId: "exec-1",
    sequence: 24,
    history,
    // 子代理恢复快照（票 04）：恢复新路径样例（完成重建 + interrupted 留痕），
    // 仅主任务携带；其余任务空数组即旧路径
    subagents: taskId === MAIN_TASK_ID ? SUBAGENTS : [],
    // 子代理运行态样例仅主任务回放
    events: taskId === MAIN_TASK_ID ? SUBAGENT_EVENTS : [],
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
