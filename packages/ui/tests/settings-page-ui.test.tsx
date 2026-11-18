// @vitest-environment jsdom
// 真实设置页与表单，经 IPC 边界验证加载、用户编辑与保存，不替换内部组件。
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

function setup() {
  let profiles = [structuredClone(profile)];
  const api = {
    providerProfiles: {
      list: vi.fn(async () => structuredClone(profiles)),
      update: vi.fn(async (id: string, input: ProviderProfileInput) => {
        const saved = { ...input, id };
        profiles = profiles.map((item) => (item.id === id ? saved : item));
        return saved;
      }),
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

function section(name: string) {
  const element = screen.getByRole("heading", { name }).closest("section");
  if (!element) throw new Error(`未找到设置分区 ${name}`);
  return within(element);
}

async function editProfile() {
  const api = setup();
  render(<SettingsPage />);
  await screen.findByText("测试接入", { exact: true });
  fireEvent.click(section("模型").getByRole("button", { name: "编辑" }));
  return api;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function expectNoSaveUntilLoaded<T>(
  name: "执行" | "终端执行" | "子代理" | "MCP servers" | "搜索源",
  retryId: string,
  inputId: string,
  saveId: string,
  get: Mock<() => Promise<T>>,
  set: Mock<(input: T) => Promise<T>>,
  expectedValue: string
) {
  render(<SettingsPage />);
  const region = section(name);
  expect(await region.findByText(/读取失败/)).toBeTruthy();
  expect(region.queryByTestId(saveId)).toBeNull();
  expect(set).not.toHaveBeenCalled();
  const next = get.getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // IPC 恢复前，重试不能把默认表体暴露为可保存状态。
  get.mockImplementation(async () => {
    await held;
    return next();
  });
  fireEvent.click(region.getByTestId(retryId));
  expect(region.queryByTestId(saveId)).toBeNull();
  expect(set).not.toHaveBeenCalled();
  await act(async () => {
    release();
  });
  await waitFor(() =>
    expect((region.getByTestId(inputId) as HTMLInputElement).value).toBe(
      expectedValue
    )
  );
  expect(region.queryByText(/读取失败/)).toBeNull();
  fireEvent.click(region.getByTestId(saveId));
  await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
}

describe("SettingsPage 初始读取失败与重试", () => {
  it("F22 托盘：初读错误可见可重试，成功读取前开关禁用", async () => {
    const api = setup();
    api.traySettings.get.mockRejectedValueOnce(new Error("托盘读取失败"));
    render(<SettingsPage />);
    const region = section("启动与托盘");
    expect(await region.findByText(/托盘读取失败/)).toBeTruthy();
    expect(
      (region.getByTestId("tray-launch-at-login") as HTMLInputElement).disabled
    ).toBe(true);
    expect(api.traySettings.set).not.toHaveBeenCalled();
    fireEvent.click(region.getByTestId("tray-settings-retry"));
    await waitFor(() =>
      expect(
        (region.getByTestId("tray-launch-at-login") as HTMLInputElement)
          .disabled
      ).toBe(false)
    );
    expect(
      (region.getByTestId("tray-launch-at-login") as HTMLInputElement).checked
    ).toBe(true);
    expect(region.queryByText(/托盘读取失败/)).toBeNull();
    fireEvent.click(region.getByTestId("tray-launch-at-login"));
    await waitFor(() =>
      expect(api.traySettings.set).toHaveBeenCalledWith({
        launchAtLogin: false,
      })
    );
  });

  it("F22 模型列表：初读失败不当作空配置，显式重试后恢复", async () => {
    const api = setup();
    api.providerProfiles.list.mockRejectedValue(new Error("模型列表读取失败"));
    render(<SettingsPage />);
    const region = section("模型");
    expect(await region.findByText(/模型列表读取失败/)).toBeTruthy();
    expect(
      (region.getByTestId("profile-create") as HTMLButtonElement).disabled
    ).toBe(true);
    expect(region.queryByText(/尚未配置模型/)).toBeNull();
    expect(api.providerProfiles.create).not.toHaveBeenCalled();
    api.providerProfiles.list.mockResolvedValue([profile]);
    fireEvent.click(region.getByTestId("profile-settings-retry"));
    await region.findByText("测试接入");
    expect(region.queryByText(/模型列表读取失败/)).toBeNull();
    expect(
      (region.getByTestId("profile-create") as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("F22 MCP 列表：初读失败可重试，未读成功不能添加配置", async () => {
    const api = setup();
    api.mcp.overview.mockRejectedValueOnce(new Error("MCP 列表读取失败"));
    render(<SettingsPage />);
    const region = section("MCP servers");
    expect(await region.findByText(/MCP 列表读取失败/)).toBeTruthy();
    expect(
      (region.getByTestId("mcp-add-server") as HTMLButtonElement).disabled
    ).toBe(true);
    expect(api.mcp.addServer).not.toHaveBeenCalled();
    fireEvent.click(region.getByTestId("mcp-settings-retry"));
    await waitFor(() =>
      expect(
        (region.getByTestId("mcp-add-server") as HTMLButtonElement).disabled
      ).toBe(false)
    );
    expect(region.queryByText(/MCP 列表读取失败/)).toBeNull();
    fireEvent.click(region.getByTestId("mcp-add-server"));
    expect(region.getByTestId("mcp-server-form")).toBeTruthy();
  });

  it("F22 搜索源：初读错误可见，重试成功前不能写空配置", async () => {
    const api = setup();
    api.searchSettings.get.mockRejectedValueOnce(new Error("搜索源读取失败"));
    await expectNoSaveUntilLoaded(
      "搜索源",
      "search-settings-retry",
      "search-api-key-input",
      "search-api-key-save",
      api.searchSettings.get,
      api.searchSettings.set,
      "stored-search-key"
    );
    expect(api.searchSettings.set).toHaveBeenCalledWith({
      apiKey: "stored-search-key",
    });
  });

  it("F22 MCP 超时：初读错误可见，重试成功前不能写默认值", async () => {
    const api = setup();
    api.agentSettings.get
      .mockResolvedValueOnce(agentSettings)
      .mockRejectedValueOnce(new Error("MCP 超时读取失败"));
    await expectNoSaveUntilLoaded(
      "MCP servers",
      "mcp-timeout-settings-retry",
      "mcp-call-timeout-input",
      "mcp-timeout-settings-save",
      api.agentSettings.get,
      api.agentSettings.set,
      "60"
    );
    expect(api.agentSettings.set).toHaveBeenCalledWith(agentSettings);
  });

  it("F22 子代理：初读错误可见，重试成功前不能写默认值", async () => {
    const api = setup();
    api.subagentSettings.get.mockRejectedValueOnce(new Error("子代理读取失败"));
    await expectNoSaveUntilLoaded(
      "子代理",
      "subagent-settings-retry",
      "subagent-concurrency-input",
      "subagent-settings-save",
      api.subagentSettings.get,
      api.subagentSettings.set,
      "5"
    );
    expect(api.subagentSettings.set).toHaveBeenCalledWith(subagentSettings);
  });

  it("F22 终端：初读错误可见，重试成功前不能写默认值", async () => {
    const api = setup();
    api.terminalSettings.get.mockRejectedValueOnce(new Error("终端读取失败"));
    await expectNoSaveUntilLoaded(
      "终端执行",
      "terminal-settings-retry",
      "terminal-command-timeout-input",
      "terminal-settings-save",
      api.terminalSettings.get,
      api.terminalSettings.set,
      "90"
    );
    expect(api.terminalSettings.set).toHaveBeenCalledWith(terminalSettings);
  });

  it("F22 执行：初读错误可见，重试成功前不能写默认值", async () => {
    const api = setup();
    api.agentSettings.get.mockRejectedValueOnce(new Error("执行读取失败"));
    await expectNoSaveUntilLoaded(
      "执行",
      "execution-settings-retry",
      "execution-tool-rounds-input",
      "execution-settings-save",
      api.agentSettings.get,
      api.agentSettings.set,
      "340"
    );
    expect(api.agentSettings.set).toHaveBeenCalledWith(agentSettings);
  });
});

describe("SettingsPage Profile 上下文窗口", () => {
  it("F21 主动清空窗口从提交中剔除旧值，再次编辑仍为空", async () => {
    const api = await editProfile();
    fireEvent.change(screen.getByLabelText("上下文窗口（tokens，可选）"), {
      target: { value: "" },
    });
    fireEvent.click(section("模型").getByRole("button", { name: "保存修改" }));
    await waitFor(() =>
      expect(api.providerProfiles.update).toHaveBeenCalledTimes(1)
    );
    expect(api.providerProfiles.update.mock.calls[0]?.[1]).not.toHaveProperty(
      "contextWindowTokens"
    );
    await waitFor(() =>
      expect(
        section("模型").queryByRole("button", { name: "编辑" })
      ).not.toBeNull()
    );
    fireEvent.click(section("模型").getByRole("button", { name: "编辑" }));
    expect(
      (screen.getByLabelText("上下文窗口（tokens，可选）") as HTMLInputElement)
        .value
    ).toBe("");
  });

  it.each([
    {
      label: "名称",
      value: "改名后的接入",
      expected: { name: "改名后的接入" },
    },
    {
      label: "API Key",
      value: "new-test-key",
      expected: { apiKey: "new-test-key" },
    },
    {
      label: "模型 1",
      value: "model-two",
      expected: { models: ["model-two"] },
    },
  ])(
    "F21 仅改 $label 保留自定义上下文窗口",
    async ({ label, value, expected }) => {
      const api = await editProfile();
      expect(
        (
          screen.getByLabelText(
            "上下文窗口（tokens，可选）"
          ) as HTMLInputElement
        ).value
      ).toBe("64000");
      fireEvent.change(screen.getByLabelText(label, { exact: true }), {
        target: { value },
      });
      fireEvent.click(
        section("模型").getByRole("button", { name: "保存修改" })
      );
      await waitFor(() =>
        expect(api.providerProfiles.update).toHaveBeenCalledWith(
          "profile",
          expect.objectContaining({
            ...expected,
            contextWindowTokens: 64000,
          })
        )
      );
    }
  );
});
