import { useEffect, useState } from "react";

import {
  DEFAULT_MAX_SUBAGENT_TOOL_ROUNDS,
  resolveModelOf,
  type ProviderProfile,
} from "@codexlike/agent-core";
import type { TerminalSettings } from "@codexlike/desktop/ipc";

import {
  modelOptionValue,
  parseModelOptionValue,
  subagentFollowModelValue,
  subagentSettingsOfValue,
} from "../lib/model-options";

import { ProviderProfileForm } from "../components/ProviderProfileForm";
import { McpSettingsSection } from "../components/McpSettingsSection";
import {
  parseCompactKeepRoundsInput,
  parseContextWarningPercentInput,
  parseModelMaxRetriesInput,
  parseTaskConcurrencyLimitInput,
  parseToolRoundsInput,
} from "../lib/execution-settings-form";
import { validateTerminalTimeouts } from "../lib/terminal-settings";
import { useTheme } from "../lib/theme";

/** 编辑中态：'new' 新建；其余为正在编辑的 Profile id */
type Editing = "new" | string | null;

/** 设置页：Provider Profile 的增删改查 + 搜索源配置（其余设置项随后续工单扩展） */
export function SettingsPage() {
  const [profiles, setProfiles] = useState<ProviderProfile[] | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [loadError, setLoadError] = useState("");

  async function refresh() {
    setLoadError("");
    try {
      setProfiles(await window.codexlike.providerProfiles.list());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const editingProfile =
    editing !== null && editing !== "new"
      ? (profiles?.find((p) => p.id === editing) ?? null)
      : null;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-medium text-fg">模型</h2>
            <p className="text-xs text-fg-muted">
              OpenAI 兼容端点（baseURL + API Key + 模型）；API Key
              经系统加密存储，磁盘上无明文
            </p>
          </div>
          {editing === null && (
            <button
              type="button"
              className="rounded-md bg-accent px-3 py-1.5 text-sm text-on-accent hover:bg-accent-hover disabled:opacity-50"
              data-testid="profile-create"
              disabled={profiles === null}
              onClick={() => setEditing("new")}
            >
              + 新建模型
            </button>
          )}
        </div>

        {loadError !== "" && (
          <div
            role="alert"
            className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger-fg"
          >
            <p>加载失败：{loadError}</p>
            <button
              type="button"
              data-testid="profile-settings-retry"
              onClick={() => void refresh()}
              className="mt-2 rounded-md px-3 py-1 text-sm text-fg-muted hover:bg-hover hover:text-fg"
            >
              重试
            </button>
          </div>
        )}
        {profiles === null && loadError === "" && (
          <p role="status" className="text-sm text-fg-muted">
            正在加载…
          </p>
        )}

        <ul className="flex flex-col gap-2">
          {(profiles ?? []).map((profile) => (
            <li
              key={profile.id}
              className={
                editing === profile.id
                  ? "flex items-center justify-between"
                  : "flex items-center justify-between rounded-lg bg-surface-muted px-4 py-3"
              }
            >
              {editing === profile.id && editingProfile !== null ? (
                <div className="flex-1">
                  <ProviderProfileForm
                    initial={{
                      name: editingProfile.name,
                      baseURL: editingProfile.baseURL,
                      apiKey: editingProfile.apiKey,
                      models: editingProfile.models,
                      contextWindowTokens: editingProfile.contextWindowTokens,
                    }}
                    submitLabel="保存修改"
                    onCancel={() => setEditing(null)}
                    onSubmit={async (input) => {
                      await window.codexlike.providerProfiles.update(
                        profile.id,
                        input
                      );
                      setEditing(null);
                      await refresh();
                    }}
                  />
                </div>
              ) : (
                <>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">
                      {profile.name}
                    </p>
                    <p className="truncate text-xs text-fg-muted">
                      {profile.baseURL} · {profile.models.join("、")}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-hover hover:text-fg"
                      onClick={() => setEditing(profile.id)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-danger-bg hover:text-danger-fg"
                      onClick={() => {
                        if (window.confirm(`确定删除「${profile.name}」吗？`)) {
                          void window.codexlike.providerProfiles
                            .remove(profile.id)
                            .then(refresh);
                        }
                      }}
                    >
                      删除
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>

        {editing === "new" && (
          <ProviderProfileForm
            submitLabel="创建"
            onCancel={() => setEditing(null)}
            onSubmit={async (input) => {
              await window.codexlike.providerProfiles.create(input);
              setEditing(null);
              await refresh();
            }}
          />
        )}

        {profiles !== null && profiles.length === 0 && editing === null && (
          <p className="rounded-lg bg-surface-muted px-4 py-6 text-center text-sm text-fg-muted">
            尚未配置模型，点击「新建模型」配置第一个模型接入
          </p>
        )}
      </section>

      <ThemeSettingsSection />

      <TraySettingsSection />

      <SearchSettingsSection />
      <SubagentSettingsSection />
      <ExecutionSettingsSection />
      <TerminalSettingsSection />

      <McpSettingsSection />
    </div>
  );
}

/**
 * 外观主题区（ADR 0006）：light / dark 二选一，点击即生效并持久化
 * （与顶栏快捷切换同一 ThemeProvider 通道，无需保存按钮）。默认浅色。
 */
function ThemeSettingsSection() {
  const { theme, setTheme } = useTheme();

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-medium text-fg">外观</h2>
        <p className="text-xs text-fg-muted">
          应用主题（浅色 / 深色），全界面即时生效；重启后保持选择。
        </p>
      </div>

      <div
        data-testid="theme-settings"
        className="flex flex-col gap-3 rounded-lg bg-surface-muted px-4 py-3"
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="theme-option-light"
            className={`rounded-md px-3 py-1.5 text-sm ${
              theme === "light"
                ? "bg-accent text-on-accent"
                : "text-fg-muted hover:bg-hover hover:text-fg"
            }`}
            onClick={() => setTheme("light")}
          >
            浅色{theme === "light" ? "（当前）" : ""}
          </button>
          <button
            type="button"
            data-testid="theme-option-dark"
            className={`rounded-md px-3 py-1.5 text-sm ${
              theme === "dark"
                ? "bg-accent text-on-accent"
                : "text-fg-muted hover:bg-hover hover:text-fg"
            }`}
            onClick={() => setTheme("dark")}
          >
            深色{theme === "dark" ? "（当前）" : ""}
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * 启动与托盘区（ADR 0025，GLOSSARY「托盘驻留」「开机启动」）：
 * 开机启动开关，即点即存（主进程统一同步登录项与托盘菜单勾选，
 * 与托盘菜单切换互为镜像）；关闭主窗口驻留托盘为固定语义，仅说明不设开关。
 */
function TraySettingsSection() {
  const [launchAtLogin, setLaunchAtLogin] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function refresh() {
    setMessage(null);
    try {
      const settings = await window.codexlike.traySettings.get();
      setLaunchAtLogin(settings.launchAtLogin);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    void refresh();
    // 托盘菜单切换时（设置页已打开）实时刷新，双入口始终同显
    return window.codexlike.traySettings.onLaunchAtLoginChanged((enabled) => {
      setLaunchAtLogin(enabled);
    });
  }, []);

  function toggle(enabled: boolean) {
    if (launchAtLogin === null) return;
    setLaunchAtLogin(enabled);
    setMessage(null);
    void window.codexlike.traySettings
      .set({ launchAtLogin: enabled })
      .then((settings) => setLaunchAtLogin(settings.launchAtLogin))
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      });
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-medium text-fg">启动与托盘</h2>
        <p className="text-xs text-fg-muted">
          开机启动后随系统登录静默驻留托盘；关闭窗口时应用驻留系统托盘、任务继续后台运行。
        </p>
      </div>

      <div
        data-testid="tray-settings"
        className="flex flex-col gap-3 rounded-lg bg-surface-muted px-4 py-3"
      >
        <label className="flex cursor-pointer items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            data-testid="tray-launch-at-login"
            className="accent-accent"
            checked={launchAtLogin === true}
            disabled={launchAtLogin === null}
            onChange={(e) => toggle(e.target.checked)}
          />
          开机启动
        </label>
        <p className="text-xs text-fg-muted">
          关闭窗口不会退出应用：它最小化到系统托盘继续运行，从托盘菜单「退出」才会真正退出。
        </p>
        {launchAtLogin === null &&
          (message ? (
            <button
              type="button"
              data-testid="tray-settings-retry"
              onClick={() => void refresh()}
              className="self-start rounded-md px-3 py-1 text-sm text-fg-muted hover:bg-hover hover:text-fg"
            >
              重试
            </button>
          ) : (
            <p role="status" className="text-sm text-fg-muted">
              正在加载…
            </p>
          ))}
        {message && (
          <p
            role="alert"
            data-testid="tray-settings-message"
            className="text-xs text-danger-fg"
          >
            {message}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * 执行设置区（ADR 0017，GLOSSARY「执行设置」「工具轮次」）：
 * agent 执行参数——主任务工具轮次上限（票 01）、子代理工具轮次上限（票 02）、
 * 压缩保留轮数与上下文告警阈值（票 03）、任务并发上限（任务并发上限票 01，
 * GLOSSARY「任务并发上限」）、模型请求重试次数（模型请求重试票 03，ADR 0024
 * 「重试不做 failover」），同构输入、独立可调。
 * 改动即时保存；轮次上限与重试次数用开始时的值（回合/运行开始快照），保留轮数
 * 无「进行中」状态逐次读取（对下一次 /compact 生效）、阈值即时生效；任务并发
 * 上限由 desktop 主进程发送闸门消费，改动对队列即时生效。
 */
export function ExecutionSettingsBody(props: {
  /** 输入框当前文本（容器持有，便于回退默认后写回展示） */
  maxToolRounds: string;
  maxSubagentToolRounds: string;
  compactKeepRounds: string;
  contextWarningThresholdPercent: string;
  taskConcurrencyLimit: string;
  modelMaxRetries: string;
  onInput: (value: string) => void;
  onSubagentInput: (value: string) => void;
  onCompactKeepInput: (value: string) => void;
  onContextWarningInput: (value: string) => void;
  onTaskConcurrencyInput: (value: string) => void;
  onModelRetriesInput: (value: string) => void;
  onSave: () => void;
  saving: boolean;
  message: string;
  messageError: boolean;
}) {
  return (
    <div
      data-testid="execution-settings"
      className="flex flex-col gap-4 rounded-lg bg-surface-muted px-4 py-3"
    >
      <label className="flex flex-col gap-1 text-sm text-fg-muted">
        主任务工具轮次上限（10-1000）
        <input
          type="number"
          min={10}
          max={1000}
          step={1}
          data-testid="execution-tool-rounds-input"
          className="w-32 rounded-md bg-surface px-2.5 py-1.5 font-mono text-sm text-fg outline-none focus:ring-[1.5px] focus:ring-fg/50"
          value={props.maxToolRounds}
          onChange={(e) => props.onInput(e.target.value)}
        />
        <span className="text-xs text-fg-subtle">
          单次回复允许的工具轮次上限（防失控兜底，默认
          200）；撞限后发送消息可继续。
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm text-fg-muted">
        子代理工具轮次上限（10-1000）
        <input
          type="number"
          min={10}
          max={1000}
          step={1}
          data-testid="execution-subagent-tool-rounds-input"
          className="w-32 rounded-md bg-surface px-2.5 py-1.5 font-mono text-sm text-fg outline-none focus:ring-[1.5px] focus:ring-fg/50"
          value={props.maxSubagentToolRounds}
          onChange={(e) => props.onSubagentInput(e.target.value)}
        />
        <span className="text-xs text-fg-subtle">
          委派子代理允许的工具轮次上限（默认
          200）；撞限后报告附截断标记回流，主任务据此推进剩余工作。
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm text-fg-muted">
        压缩保留对话轮数（1-10）
        <input
          type="number"
          min={1}
          max={10}
          step={1}
          data-testid="execution-compact-keep-input"
          className="w-32 rounded-md bg-surface px-2.5 py-1.5 font-mono text-sm text-fg outline-none focus:ring-[1.5px] focus:ring-fg/50"
          value={props.compactKeepRounds}
          onChange={(e) => props.onCompactKeepInput(e.target.value)}
        />
        <span className="text-xs text-fg-subtle">
          执行 /compact 压缩历史后保留的最近对话轮数（默认
          3）；改动对下一次压缩生效。
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm text-fg-muted">
        上下文告警阈值（50-95%）
        <input
          type="number"
          min={50}
          max={95}
          step={1}
          data-testid="execution-context-warning-input"
          className="w-32 rounded-md bg-surface px-2.5 py-1.5 font-mono text-sm text-fg outline-none focus:ring-[1.5px] focus:ring-fg/50"
          value={props.contextWarningThresholdPercent}
          onChange={(e) => props.onContextWarningInput(e.target.value)}
        />
        <span className="text-xs text-fg-subtle">
          上下文用量达到上下文窗口的百分之多少时提醒（默认
          80%）；窗口由接入设置的 Provider Profile 逐模型配置。
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm text-fg-muted">
        任务并发上限（1-8）
        <input
          type="number"
          min={1}
          max={8}
          step={1}
          data-testid="execution-task-concurrency-input"
          className="w-32 rounded-md bg-surface px-2.5 py-1.5 font-mono text-sm text-fg outline-none focus:ring-[1.5px] focus:ring-fg/50"
          value={props.taskConcurrencyLimit}
          onChange={(e) => props.onTaskConcurrencyInput(e.target.value)}
        />
        <span className="text-xs text-fg-subtle">
          同时执行的任务个数上限（默认 3）；达到上限时新任务排队等待，
          有空位按发起顺序自动开跑。
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm text-fg-muted">
        模型请求重试次数（0-10）
        <input
          type="number"
          min={0}
          max={10}
          step={1}
          data-testid="execution-model-retries-input"
          className="w-32 rounded-md bg-surface px-2.5 py-1.5 font-mono text-sm text-fg outline-none focus:ring-[1.5px] focus:ring-fg/50"
          value={props.modelMaxRetries}
          onChange={(e) => props.onModelRetriesInput(e.target.value)}
        />
        <span className="text-xs text-fg-subtle">
          模型请求失败后的自动重试次数（默认 2），作用于对话、压缩与子代理的
          全部模型请求；设为 0 关闭重试，调试时快速失败。
        </span>
      </label>

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          data-testid="execution-settings-save"
          disabled={props.saving}
          className="rounded-md bg-accent px-3 py-1.5 text-sm text-on-accent hover:bg-accent-hover disabled:opacity-50"
          onClick={props.onSave}
        >
          {props.saving ? "保存中…" : "保存"}
        </button>
        {props.message !== "" && (
          <p
            data-testid="execution-settings-message"
            className={`text-xs ${props.messageError ? "text-danger-fg" : "text-ok-fg"}`}
          >
            {props.message}
          </p>
        )}
      </div>
    </div>
  );
}

/** 执行设置容器：IPC 装载与保存（非法输入经各解析函数回退默认值） */
function ExecutionSettingsSection() {
  const [maxToolRounds, setMaxToolRounds] = useState("200");
  const [maxSubagentToolRounds, setMaxSubagentToolRounds] = useState("200");
  const [compactKeepRounds, setCompactKeepRounds] = useState("3");
  const [contextWarningThresholdPercent, setContextWarningThresholdPercent] =
    useState("80");
  const [taskConcurrencyLimit, setTaskConcurrencyLimit] = useState("3");
  const [modelMaxRetries, setModelMaxRetries] = useState("2");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);

  async function refresh() {
    setMessage("");
    setMessageError(false);
    try {
      const settings = await window.codexlike.agentSettings.get();
      setMaxToolRounds(String(settings.maxToolRounds));
      setMaxSubagentToolRounds(String(settings.maxSubagentToolRounds));
      setCompactKeepRounds(String(settings.compactKeepRounds));
      setContextWarningThresholdPercent(
        String(settings.contextWarningThresholdPercent)
      );
      setTaskConcurrencyLimit(String(settings.taskConcurrencyLimit));
      setModelMaxRetries(String(settings.modelMaxRetries));
      setLoaded(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageError(true);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save() {
    if (!loaded) return;
    setSaving(true);
    setMessage("");
    try {
      // 非法/越界输入回退默认值（ADR 0017）；回退值写回输入框可见。
      // 六项各自解析、一次保存（独立字段，互不影响）；MCP 超时两项（票 07）
      // 不在本分区编辑——保存时读取当前最新值原样回传（IPC 八字段整体形状），
      // 避免用装载快照覆盖 MCP 分区的并发保存。
      const current = await window.codexlike.agentSettings.get();
      const settings = await window.codexlike.agentSettings.set({
        maxToolRounds: parseToolRoundsInput(maxToolRounds),
        maxSubagentToolRounds: parseToolRoundsInput(
          maxSubagentToolRounds,
          DEFAULT_MAX_SUBAGENT_TOOL_ROUNDS
        ),
        compactKeepRounds: parseCompactKeepRoundsInput(compactKeepRounds),
        contextWarningThresholdPercent: parseContextWarningPercentInput(
          contextWarningThresholdPercent
        ),
        taskConcurrencyLimit:
          parseTaskConcurrencyLimitInput(taskConcurrencyLimit),
        modelMaxRetries: parseModelMaxRetriesInput(modelMaxRetries),
        mcpCallTimeoutSeconds: current.mcpCallTimeoutSeconds,
        mcpConnectTimeoutSeconds: current.mcpConnectTimeoutSeconds,
      });
      setMaxToolRounds(String(settings.maxToolRounds));
      setMaxSubagentToolRounds(String(settings.maxSubagentToolRounds));
      setCompactKeepRounds(String(settings.compactKeepRounds));
      setContextWarningThresholdPercent(
        String(settings.contextWarningThresholdPercent)
      );
      setTaskConcurrencyLimit(String(settings.taskConcurrencyLimit));
      setModelMaxRetries(String(settings.modelMaxRetries));
      setMessage(
        `已保存：主任务工具轮次上限 ${settings.maxToolRounds}、子代理工具轮次上限 ${settings.maxSubagentToolRounds}、压缩保留对话轮数 ${settings.compactKeepRounds}、上下文告警阈值 ${settings.contextWarningThresholdPercent}%、任务并发上限 ${settings.taskConcurrencyLimit}、模型请求重试次数 ${settings.modelMaxRetries}`
      );
      setMessageError(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-medium text-fg">执行</h2>
        <p className="text-xs text-fg-muted">
          agent
          执行参数。改动即时保存，已开始的执行用开始时的值；后续执行参数随版本扩展。
        </p>
      </div>

      {!loaded && (
        <div
          role={messageError ? "alert" : "status"}
          className="text-sm text-fg-muted"
        >
          {messageError ? (
            <>
              <p className="text-danger-fg">加载失败：{message}</p>
              <button
                type="button"
                data-testid="execution-settings-retry"
                onClick={() => void refresh()}
                className="mt-2 rounded-md px-3 py-1 text-sm text-fg-muted hover:bg-hover hover:text-fg"
              >
                重试
              </button>
            </>
          ) : (
            "正在加载…"
          )}
        </div>
      )}
      {loaded && (
        <ExecutionSettingsBody
          maxToolRounds={maxToolRounds}
          maxSubagentToolRounds={maxSubagentToolRounds}
          compactKeepRounds={compactKeepRounds}
          contextWarningThresholdPercent={contextWarningThresholdPercent}
          taskConcurrencyLimit={taskConcurrencyLimit}
          modelMaxRetries={modelMaxRetries}
          onInput={setMaxToolRounds}
          onSubagentInput={setMaxSubagentToolRounds}
          onCompactKeepInput={setCompactKeepRounds}
          onContextWarningInput={setContextWarningThresholdPercent}
          onTaskConcurrencyInput={setTaskConcurrencyLimit}
          onModelRetriesInput={setModelMaxRetries}
          onSave={() => void save()}
          saving={saving}
          message={message}
          messageError={messageError}
        />
      )}
    </section>
  );
}

/**
 * 终端执行设置区（code review 修复 1 + 执行设置票04）：
 * run_terminal_command 的 shell（Git Bash 默认 / PowerShell / cmd）
 * 与命令超时、最大命令超时两项（跑构建/测试不被默认 30s 打断）。
 * 保存后经主进程内存缓存逐次解析，对下一次终端命令即时生效（无需重启任务）。
 */
function TerminalSettingsSection() {
  const [shell, setShell] = useState<"git-bash" | "powershell" | "cmd">(
    "git-bash"
  );
  const [commandTimeout, setCommandTimeout] = useState("30");
  const [maxCommandTimeout, setMaxCommandTimeout] = useState("120");
  const [loaded, setLoaded] = useState(false);
  const [shellConfigured, setShellConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);

  async function refresh() {
    setMessage("");
    setMessageError(false);
    try {
      const settings: TerminalSettings =
        await window.codexlike.terminalSettings.get();
      // shell 未配置时默认展示 Git Bash（保存前 CODEXLIKE_SHELL 环境变量兜底）
      setShell(settings.shell ?? "git-bash");
      setShellConfigured(settings.shell !== null);
      setCommandTimeout(String(settings.commandTimeoutSeconds));
      setMaxCommandTimeout(String(settings.maxCommandTimeoutSeconds));
      setLoaded(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageError(true);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save() {
    if (!loaded) return;
    // 联动校验先于请求：越界/非法输入在 UI 层即被阻止（渲染层同样不可信的
    // 最终把关在主进程 IPC 边界）
    const validationError = validateTerminalTimeouts(
      commandTimeout,
      maxCommandTimeout
    );
    if (validationError !== null) {
      setMessage(validationError);
      setMessageError(true);
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const settings = await window.codexlike.terminalSettings.set({
        shell,
        commandTimeoutSeconds: Number(commandTimeout),
        maxCommandTimeoutSeconds: Number(maxCommandTimeout),
      });
      setCommandTimeout(String(settings.commandTimeoutSeconds));
      setMaxCommandTimeout(String(settings.maxCommandTimeoutSeconds));
      setLoaded(true);
      setMessage("终端设置已保存（对下一次终端命令生效）");
      setMessageError(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-medium text-fg">终端执行</h2>
        <p className="text-xs text-fg-muted">
          run_terminal_command 工具使用的 shell（默认 Git Bash，POSIX
          命令可用）与命令超时、最大命令超时（跑构建/测试不被默认 30 秒打断）。
          {loaded &&
            shellConfigured === false &&
            " shell 尚未配置时环境变量 CODEXLIKE_SHELL 可兜底指定。"}
        </p>
      </div>

      {!loaded && (
        <div
          role={messageError ? "alert" : "status"}
          className="text-sm text-fg-muted"
        >
          {messageError ? (
            <>
              <p className="text-danger-fg">加载失败：{message}</p>
              <button
                type="button"
                data-testid="terminal-settings-retry"
                onClick={() => void refresh()}
                className="mt-2 rounded-md px-3 py-1 text-sm text-fg-muted hover:bg-hover hover:text-fg"
              >
                重试
              </button>
            </>
          ) : (
            "正在加载…"
          )}
        </div>
      )}
      {loaded && (
        <div
          data-testid="terminal-settings"
          className="flex flex-col gap-4 rounded-lg bg-surface-muted px-4 py-3"
        >
          <label className="flex flex-col gap-1 text-sm text-fg-muted">
            Shell
            <select
              data-testid="terminal-shell-select"
              className="w-48 rounded-md bg-surface px-2.5 py-1.5 text-sm text-fg outline-none focus:ring-[1.5px] focus:ring-fg/50"
              value={shell}
              onChange={(e) => setShell(e.target.value as typeof shell)}
            >
              <option value="git-bash">Git Bash（默认）</option>
              <option value="powershell">PowerShell</option>
              <option value="cmd">cmd</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm text-fg-muted">
            命令超时（5-600 秒）
            <input
              type="number"
              min={5}
              max={600}
              step={1}
              data-testid="terminal-command-timeout-input"
              className="w-32 rounded-md bg-surface px-2.5 py-1.5 font-mono text-sm text-fg outline-none focus:ring-[1.5px] focus:ring-fg/50"
              value={commandTimeout}
              onChange={(e) => setCommandTimeout(e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm text-fg-muted">
            最大命令超时（10-1800 秒）
            <input
              type="number"
              min={10}
              max={1800}
              step={1}
              data-testid="terminal-max-command-timeout-input"
              className="w-32 rounded-md bg-surface px-2.5 py-1.5 font-mono text-sm text-fg outline-none focus:ring-[1.5px] focus:ring-fg/50"
              value={maxCommandTimeout}
              onChange={(e) => setMaxCommandTimeout(e.target.value)}
            />
          </label>

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              data-testid="terminal-settings-save"
              disabled={saving}
              className="rounded-md bg-accent px-3 py-1.5 text-sm text-on-accent hover:bg-accent-hover disabled:opacity-50"
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存"}
            </button>
            {message !== "" && (
              <p
                data-testid="terminal-settings-message"
                className={`text-xs ${messageError ? "text-danger-fg" : "text-ok-fg"}`}
              >
                {message}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * 子代理全局配置区（工单 13，GLOSSARY「子代理」；票 02 升级模型级）：
 * 子代理模型可选到具体「Profile · 模型」（默认同主模型 = 跟随主任务当前
 * 所用模型）+ 并发上限（默认 3，1-8）。保存后对后续任务/下一次委派即时
 * 生效（主进程逐次解析内存缓存）。
 */
function SubagentSettingsSection() {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  /** 复合值：`${profileId}::${model}`；空 model 位 = 跟随占位；空串 = 同主模型 */
  const [modelValue, setModelValue] = useState<string>("");
  const [maxConcurrent, setMaxConcurrent] = useState("3");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);

  async function refresh() {
    setMessage("");
    setMessageError(false);
    try {
      const [profileList, settings] = await Promise.all([
        window.codexlike.providerProfiles.list(),
        window.codexlike.subagentSettings.get(),
      ]);
      setProfiles(profileList);
      // 引用的 Profile 已删除时回落为同主模型；model 为 null（未选具体
      // 模型）回显「跟随」占位而不落成具体模型（review 修复 1：未改选
      // 保存保留 null，子代理继续跟随主任务当前所用模型）；模型记录失效
      // （已从列表删除）回退该 Profile 列表第一项（resolveModelOf 同语义）
      const profile = profileList.find(
        (p) => p.id === settings.providerProfileId
      );
      if (profile) {
        setModelValue(
          settings.model === null
            ? subagentFollowModelValue(profile.id)
            : modelOptionValue(
                profile.id,
                resolveModelOf(profile, settings.model)
              )
        );
      } else {
        setModelValue("");
      }
      setMaxConcurrent(String(settings.maxConcurrent));
      setLoaded(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageError(true);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // 跟随占位项（review 修复 1）：当前选中值为空 model 位复合键时才渲染
  // 显式占位（已选 Profile、未选具体模型）；选了具体模型或「同主模型」后消失
  const followParsed = parseModelOptionValue(modelValue);
  const followProfile =
    followParsed?.model === ""
      ? profiles.find((p) => p.id === followParsed.profileId)
      : undefined;

  async function save() {
    if (!loaded) return;
    setSaving(true);
    setMessage("");
    try {
      const parsed = subagentSettingsOfValue(modelValue);
      const settings = await window.codexlike.subagentSettings.set({
        providerProfileId: parsed.providerProfileId,
        model: parsed.model,
        maxConcurrent: Number(maxConcurrent),
      });
      setMaxConcurrent(String(settings.maxConcurrent));
      setMessage("子代理设置已保存（对后续任务与下一次委派生效）");
      setMessageError(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-medium text-fg">子代理</h2>
        <p className="text-xs text-fg-muted">
          spawn_subagent
          委派的子代理使用的模型与并发上限。子代理拥有独立上下文与完整工具集
          （不可再委派子代理）；并发上限外的委派将排队等待。
        </p>
      </div>

      {!loaded && (
        <div
          role={messageError ? "alert" : "status"}
          className="text-sm text-fg-muted"
        >
          {messageError ? (
            <>
              <p className="text-danger-fg">加载失败：{message}</p>
              <button
                type="button"
                data-testid="subagent-settings-retry"
                onClick={() => void refresh()}
                className="mt-2 rounded-md px-3 py-1 text-sm text-fg-muted hover:bg-hover hover:text-fg"
              >
                重试
              </button>
            </>
          ) : (
            "正在加载…"
          )}
        </div>
      )}
      {loaded && (
        <div
          data-testid="subagent-settings"
          className="flex flex-col gap-4 rounded-lg bg-surface-muted px-4 py-3"
        >
          <label className="flex flex-col gap-1 text-sm text-fg-muted">
            子代理模型
            <select
              data-testid="subagent-profile-select"
              className="w-80 rounded-md bg-surface px-2.5 py-1.5 text-sm text-fg outline-none focus:ring-[1.5px] focus:ring-fg/50"
              value={modelValue}
              onChange={(e) => setModelValue(e.target.value)}
            >
              <option value="">同主模型（跟随主任务当前使用的模型）</option>
              {followProfile !== undefined && (
                <option value={modelValue}>
                  {followProfile.name} · 跟随主任务模型（未选具体模型）
                </option>
              )}
              {profiles.flatMap((profile) =>
                profile.models.map((model) => (
                  <option
                    key={modelOptionValue(profile.id, model)}
                    value={modelOptionValue(profile.id, model)}
                  >
                    {profile.name} · {model}
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm text-fg-muted">
            并发上限（1-8）
            <input
              type="number"
              min={1}
              max={8}
              step={1}
              data-testid="subagent-concurrency-input"
              className="w-32 rounded-md bg-surface px-2.5 py-1.5 font-mono text-sm text-fg outline-none focus:ring-[1.5px] focus:ring-fg/50"
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(e.target.value)}
            />
          </label>

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              data-testid="subagent-settings-save"
              disabled={saving}
              className="rounded-md bg-accent px-3 py-1.5 text-sm text-on-accent hover:bg-accent-hover disabled:opacity-50"
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存"}
            </button>
            {message !== "" && (
              <p
                data-testid="subagent-settings-message"
                className={`text-xs ${messageError ? "text-danger-fg" : "text-ok-fg"}`}
              >
                {message}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** 搜索源配置区（工单 10）：默认 Tavily；key 经 safeStorage 加密存储，改完对进行中的任务即时生效 */
function SearchSettingsSection() {
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);

  async function refresh() {
    setMessage("");
    setMessageError(false);
    try {
      const settings = await window.codexlike.searchSettings.get();
      setApiKey(settings.apiKey);
      setConfigured(settings.apiKey !== "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageError(true);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save(nextKey: string) {
    if (configured === null) return;
    setSaving(true);
    setMessage("");
    try {
      const settings = await window.codexlike.searchSettings.set({
        apiKey: nextKey,
      });
      setApiKey(settings.apiKey);
      setConfigured(settings.apiKey !== "");
      setMessage(
        nextKey === "" ? "已清除搜索源配置" : "搜索源已保存，web_search 可用"
      );
      setMessageError(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-medium text-fg">搜索源</h2>
        <p className="text-xs text-fg-muted">
          web_search 工具使用的搜索服务（默认 Tavily，https://tavily.com
          注册，免费 1000 次/月）；API key
          经系统加密存储。配置后无需重启任务即可生效。
        </p>
      </div>

      {configured === null && (
        <div
          role={messageError ? "alert" : "status"}
          className="text-sm text-fg-muted"
        >
          {messageError ? (
            <>
              <p className="text-danger-fg">加载失败：{message}</p>
              <button
                type="button"
                data-testid="search-settings-retry"
                onClick={() => void refresh()}
                className="mt-2 rounded-md px-3 py-1 text-sm text-fg-muted hover:bg-hover hover:text-fg"
              >
                重试
              </button>
            </>
          ) : (
            "正在加载…"
          )}
        </div>
      )}
      {configured !== null && (
        <div className="flex flex-col gap-3 rounded-lg bg-surface-muted px-4 py-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs text-fg-muted">
              Tavily
            </span>
            <span className={configured ? "text-ok-fg" : "text-warn-fg"}>
              {configured
                ? "已配置"
                : "未配置（web_search 将提示先在设置页填写 key）"}
            </span>
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              data-testid="search-api-key-input"
              className="min-w-0 flex-1 rounded-md bg-surface px-2.5 py-1.5 font-mono text-sm text-fg outline-none focus:ring-[1.5px] focus:ring-fg/50"
              placeholder="Tavily API key（tvly-…）"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            {configured && (
              <button
                type="button"
                disabled={saving}
                className="rounded-md px-3 py-1.5 text-sm text-fg-muted hover:bg-danger-bg hover:text-danger-fg disabled:opacity-50"
                onClick={() => void save("")}
              >
                清除
              </button>
            )}
            <button
              type="button"
              data-testid="search-api-key-save"
              disabled={saving || apiKey.trim() === ""}
              className="rounded-md bg-accent px-3 py-1.5 text-sm text-on-accent hover:bg-accent-hover disabled:opacity-50"
              onClick={() => void save(apiKey.trim())}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
          {message !== "" && (
            <p
              data-testid="search-settings-message"
              className={`text-xs ${messageError ? "text-danger-fg" : "text-ok-fg"}`}
            >
              {message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
