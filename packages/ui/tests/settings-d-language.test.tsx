// @vitest-environment jsdom
// D 设计语言（ADR 0028）设置页断言：分区卡暖灰无边框、输入白卡聚焦描边、
// 小钮 6px 圆角、主钮黑主张、checkbox accent 化——期望值来自 notes.md 定案，
// 断言组件公开渲染面（className），不触内部实现。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type {
  ProviderProfile,
  ProviderProfileInput,
} from "@codexlike/agent-core";
import type {
  AgentSettings,
  CodexLikeApi,
  SubagentSettings,
  TerminalSettings,
} from "@codexlike/desktop/ipc";
import { SettingsPage } from "../src/pages/SettingsPage";
import { ProviderProfileForm } from "../src/components/ProviderProfileForm";
import {
  McpSettingsSection,
  McpTimeoutSettingsBody,
} from "../src/components/McpSettingsSection";

const profile: ProviderProfile = {
  id: "profile",
  name: "测试接入",
  baseURL: "https://example.invalid/v1",
  apiKey: "test-key",
  models: ["model-one"],
  contextWindowTokens: 64000,
};
const agentSettings: AgentSettings = {
  maxToolRounds: 340,
  maxSubagentToolRounds: 240,
  compactKeepRounds: 5,
  contextWarningThresholdPercent: 75,
  taskConcurrencyLimit: 4,
  modelMaxRetries: 3,
  mcpCallTimeoutSeconds: 60,
  mcpConnectTimeoutSeconds: 45,
};
const terminalSettings: TerminalSettings = {
  shell: "powershell",
  commandTimeoutSeconds: 90,
  maxCommandTimeoutSeconds: 300,
};
const subagentSettings: SubagentSettings = {
  providerProfileId: profile.id,
  model: "model-one",
  maxConcurrent: 5,
};

function setup(overrides?: {
  profiles?: ProviderProfile[];
  /** 替换 list 实现（如抛错），保持 mock 引用不变 */
  listImpl?: () => Promise<ProviderProfile[]>;
}) {
  const api = {
    providerProfiles: {
      list: vi.fn(
        overrides?.listImpl ??
          (async () => structuredClone(overrides?.profiles ?? [profile]))
      ),
      update: vi.fn(async (id: string, input: ProviderProfileInput) => ({
        ...input,
        id,
      })),
      create: vi.fn(async (input: ProviderProfileInput) => ({
        ...input,
        id: "new",
      })),
    },
    agentSettings: {
      get: vi.fn(async () => structuredClone(agentSettings)),
      set: vi.fn(async (input: AgentSettings) => input),
    },
    terminalSettings: {
      get: vi.fn(async () => structuredClone(terminalSettings)),
      set: vi.fn(async (input: TerminalSettings) => input),
    },
    subagentSettings: {
      get: vi.fn(async () => structuredClone(subagentSettings)),
      set: vi.fn(async (input: SubagentSettings) => input),
    },
    searchSettings: {
      get: vi.fn(async () => ({ apiKey: "stored-search-key" })),
      set: vi.fn(async (input: { apiKey: string }) => input),
    },
    traySettings: {
      get: vi.fn(async () => ({ launchAtLogin: true })),
      set: vi.fn(async (input: { launchAtLogin: boolean }) => input),
      onLaunchAtLoginChanged: vi.fn(() => () => {}),
    },
    mcp: {
      overview: vi.fn<CodexLikeApi["mcp"]["overview"]>(async () => ({
        servers: [],
      })),
      addServer: vi.fn<CodexLikeApi["mcp"]["addServer"]>(),
    },
  };
  vi.stubGlobal("codexlike", api);
  return api;
}

/** 暖灰块断言：去边框、surface-muted 底、8px 圆角（D 无边框纪律） */
function expectMutedCard(element: Element) {
  expect(element.className).toContain("bg-surface-muted");
  expect(element.className).not.toContain("border-line");
  expect(element.className).toContain("rounded-lg");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("D 语言：SettingsPage 七分区", () => {
  it("分区卡去边框换暖灰块（外观/托盘/执行/终端/子代理）", async () => {
    setup();
    render(<SettingsPage />);
    for (const id of [
      "theme-settings",
      "tray-settings",
      "execution-settings",
      "terminal-settings",
      "subagent-settings",
    ]) {
      expectMutedCard(await screen.findByTestId(id));
    }
  });

  it("搜索源卡与 Profile 列表行同为暖灰块", async () => {
    setup();
    render(<SettingsPage />);
    // 搜索源卡无专属 testid：从 key 输入框上溯两级（input → 按钮行 → 卡）
    const card = (await screen.findByTestId("search-api-key-input")).closest(
      "div.rounded-lg"
    );
    expect(card).not.toBeNull();
    expectMutedCard(card!);
    const row = screen.getByText("测试接入", { exact: true }).closest("li");
    expect(row).not.toBeNull();
    expectMutedCard(row!);
  });

  it("主题选择：激活黑主张，未激活去边框 hover 暖灰", async () => {
    setup();
    render(<SettingsPage />);
    const light = await screen.findByTestId("theme-option-light");
    expect(light.className).toContain("bg-accent");
    expect(light.className).toContain("text-on-accent");
    const dark = screen.getByTestId("theme-option-dark");
    expect(dark.className).not.toContain("border");
    expect(dark.className).toContain("hover:bg-hover");
  });

  it("主按钮黑主张 + 6px 圆角，次级按钮去边框", async () => {
    setup();
    render(<SettingsPage />);
    for (const id of ["profile-create", "execution-settings-save"]) {
      const button = await screen.findByTestId(id);
      expect(button.className).toContain("bg-accent");
      expect(button.className).toContain("rounded-md");
    }
    // 次级按钮（搜索源清除）：无描边、hover 语义反馈
    const clear = screen.getByRole("button", { name: "清除" });
    expect(clear.className).not.toContain("border-line");
    expect(clear.className).toContain("hover:bg-danger-bg");
  });

  it("checkbox 开关 accent 化（黑主张，深色翻白）", async () => {
    setup();
    render(<SettingsPage />);
    expect(
      (await screen.findByTestId("tray-launch-at-login")).className
    ).toContain("accent-accent");
  });

  it("数字/密码输入为白卡 + 聚焦深色细描边（ring，非 border）", async () => {
    setup();
    render(<SettingsPage />);
    for (const id of [
      "execution-tool-rounds-input",
      "terminal-command-timeout-input",
      "subagent-concurrency-input",
      "search-api-key-input",
    ]) {
      const input = await screen.findByTestId(id);
      expect(input.className).toContain("bg-surface");
      expect(input.className).not.toContain("border-line");
      expect(input.className).not.toContain("bg-code-bg");
      expect(input.className).toContain("focus:ring");
    }
  });

  it("下拉选择器与输入同语言（白卡 + 聚焦描边）", async () => {
    setup();
    render(<SettingsPage />);
    for (const id of ["terminal-shell-select", "subagent-profile-select"]) {
      const select = await screen.findByTestId(id);
      expect(select.className).toContain("bg-surface");
      expect(select.className).not.toContain("border-line");
      expect(select.className).toContain("focus:ring");
    }
  });

  it("空状态去虚线框换暖灰块", async () => {
    setup({ profiles: [] });
    render(<SettingsPage />);
    const empty = await screen.findByText(/尚未配置模型/);
    expect(empty.className).not.toContain("border-dashed");
    expect(empty.className).toContain("bg-surface-muted");
  });

  it("加载失败提示条去边框留 danger 软底", async () => {
    setup({
      listImpl: async () => {
        throw new Error("模型列表读取失败");
      },
    });
    render(<SettingsPage />);
    const alert = (await screen.findByTestId("profile-settings-retry")).closest(
      '[role="alert"]'
    );
    expect(alert).not.toBeNull();
    expect(alert!.className).not.toContain("border");
    expect(alert!.className).toContain("bg-danger-bg");
  });
});

describe("D 语言：ProviderProfileForm", () => {
  it("表单卡为暖灰块（无边框），输入为白卡 + 聚焦描边", () => {
    render(
      <ProviderProfileForm
        submitLabel="创建"
        onCancel={() => {}}
        onSubmit={async () => {}}
      />
    );
    const form = document.querySelector("form")!;
    expect(form.className).toContain("bg-surface-muted");
    expect(form.className).not.toContain("border-line");
    expect(form.className).toContain("rounded-lg");
    const nameInput = screen.getByLabelText("名称", { exact: true });
    expect(nameInput.className).toContain("bg-surface");
    expect(nameInput.className).not.toContain("border-line");
    expect(nameInput.className).not.toContain("bg-code-bg");
    expect(nameInput.className).toContain("focus:ring");
    const modelInput = screen.getByLabelText("模型 1");
    expect(modelInput.className).toContain("bg-surface");
    expect(modelInput.className).toContain("focus:ring");
  });

  it("默认模型徽章换白卡中性色（不再借 accent 淡底）", () => {
    render(
      <ProviderProfileForm
        submitLabel="创建"
        onCancel={() => {}}
        onSubmit={async () => {}}
      />
    );
    const badge = screen.getByTestId("default-model-badge");
    expect(badge.className).not.toContain("bg-accent");
    expect(badge.className).not.toContain("text-accent");
    expect(badge.className).toContain("bg-surface");
  });

  it("校验错误态用 danger 细描边（ring，非 border）", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(
      <ProviderProfileForm
        submitLabel="创建"
        onCancel={() => {}}
        onSubmit={async () => {}}
      />
    );
    const nameInput = screen.getByLabelText("名称", { exact: true });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(nameInput.className).toContain("ring-danger-fg");
    expect(nameInput.className).not.toContain("border-danger-fg");
  });

  it("model-row 行操作小钮与主次按钮统一 6px 圆角、次级去边框", () => {
    render(
      <ProviderProfileForm
        submitLabel="创建"
        onCancel={() => {}}
        onSubmit={async () => {}}
      />
    );
    for (const name of ["添加模型", "上移", "下移", "删除"]) {
      const button = screen.getAllByRole("button", { name })[0]!;
      expect(button.className).toContain("rounded-md");
      expect(button.className).not.toContain("border-line");
    }
    const cancel = screen.getByRole("button", { name: "取消" });
    expect(cancel.className).not.toContain("border-line");
    const submit = screen.getByRole("button", { name: "创建" });
    expect(submit.className).toContain("bg-accent");
    expect(submit.className).toContain("rounded-md");
  });
});

describe("D 语言：MCP 分区", () => {
  function setupMcp(servers: unknown[]) {
    vi.stubGlobal("codexlike", {
      agentSettings: {
        get: vi.fn(async () => structuredClone(agentSettings)),
        set: vi.fn(async (input: AgentSettings) => input),
      },
      mcp: {
        overview: vi.fn(async () => ({ servers })),
        addServer: vi.fn(),
        removeServer: vi.fn(async () => {}),
        reconnect: vi.fn(),
        setToolEnabled: vi.fn(async () => {}),
      },
    });
  }

  const servers = [
    {
      config: { id: "s1", name: "filesystem", command: "node", args: ["s.js"] },
      status: "connected",
      error: null,
      tools: [
        {
          name: "read_file",
          description: "读文件",
          enabled: true,
        },
      ],
    },
    {
      config: { id: "s2", name: "broken", command: "nope", args: [] },
      status: "failed",
      error: "spawn nope ENOENT",
      tools: [],
    },
  ];

  it("server 列表行为暖灰块，工具行为白卡、工具名不再借 accent", async () => {
    setupMcp(servers);
    render(<McpSettingsSection />);
    const items = await screen.findAllByTestId("mcp-server-item");
    for (const item of items) {
      expect(item.className).toContain("bg-surface-muted");
      expect(item.className).not.toContain("border-line");
      expect(item.className).toContain("rounded-lg");
    }
    const toggle = await screen.findByTestId("mcp-tool-toggle-read_file");
    const toolRow = toggle.closest("li");
    expect(toolRow).not.toBeNull();
    expect(toolRow!.className).toContain("bg-surface");
    expect(toolRow!.className).not.toContain("bg-code-bg");
    const toolName = toolRow!.querySelector("p.font-mono");
    expect(toolName!.className).toContain("text-fg");
    expect(toolName!.className).not.toContain("text-accent");
  });

  it("工具启停 checkbox accent 化，行操作小钮 6px 圆角", async () => {
    setupMcp(servers);
    render(<McpSettingsSection />);
    const toggle = await screen.findByTestId("mcp-tool-toggle-read_file");
    expect(toggle.className).toContain("accent-accent");
    const reconnect = screen.getAllByTestId("mcp-reconnect")[0]!;
    expect(reconnect.className).toContain("rounded-md");
    expect(reconnect.className).not.toContain("border-line");
    const remove = screen.getAllByTestId("mcp-remove")[0]!;
    expect(remove.className).toContain("rounded-md");
  });

  it("连接错误行去边框留 danger 软底，状态色保持可辨", async () => {
    setupMcp(servers);
    render(<McpSettingsSection />);
    const errorText = await screen.findByText(/spawn nope ENOENT/);
    expect(errorText.className).not.toContain("border");
    expect(errorText.className).toContain("bg-danger-bg");
    expect(
      (await screen.findByTestId("mcp-status-broken")).className
    ).toContain("text-danger-fg");
    expect(
      (await screen.findByTestId("mcp-status-filesystem")).className
    ).toContain("text-ok-fg");
  });

  it("添加 server 表单为暖灰块，输入/textarea 为白卡聚焦描边", async () => {
    setupMcp(servers);
    render(<McpSettingsSection />);
    const add = await screen.findByTestId("mcp-add-server");
    expect(add.className).toContain("bg-accent");
    expect(add.className).toContain("rounded-md");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(add);
    const form = screen.getByTestId("mcp-server-form");
    expect(form.className).toContain("bg-surface-muted");
    expect(form.className).not.toContain("border-line");
    for (const id of [
      "mcp-form-name",
      "mcp-form-command",
      "mcp-form-args",
      "mcp-form-env",
    ]) {
      const input = screen.getByTestId(id);
      expect(input.className).toContain("bg-surface");
      expect(input.className).not.toContain("border-line");
      expect(input.className).toContain("focus:ring");
    }
    const submit = screen.getByTestId("mcp-form-submit");
    expect(submit.className).toContain("bg-accent");
    expect(submit.className).toContain("rounded-md");
  });

  it("空状态去虚线框换暖灰块", async () => {
    setupMcp([]);
    render(<McpSettingsSection />);
    const empty = await screen.findByText(/还没有配置 MCP server/);
    expect(empty.className).not.toContain("border-dashed");
    expect(empty.className).toContain("bg-surface-muted");
  });
});

describe("D 语言：MCP 超时表体", () => {
  it("容器暖灰块，输入白卡聚焦描边，保存钮黑主张 6px 圆角", () => {
    render(
      <McpTimeoutSettingsBody
        callTimeout="60"
        connectTimeout="45"
        onCallInput={() => {}}
        onConnectInput={() => {}}
        onSave={() => {}}
        saving={false}
        message=""
        messageError={false}
      />
    );
    const card = screen.getByTestId("mcp-timeout-settings");
    expect(card.className).toContain("bg-surface-muted");
    expect(card.className).not.toContain("border-line");
    for (const id of ["mcp-call-timeout-input", "mcp-connect-timeout-input"]) {
      const input = screen.getByTestId(id);
      expect(input.className).toContain("bg-surface");
      expect(input.className).not.toContain("border-line");
      expect(input.className).toContain("focus:ring");
    }
    const save = screen.getByTestId("mcp-timeout-settings-save");
    expect(save.className).toContain("bg-accent");
    expect(save.className).toContain("rounded-md");
  });
});
