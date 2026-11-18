import { useEffect, useState } from "react";

import type { McpServerView } from "@codexlike/desktop/ipc";

import {
  parseMcpCallTimeoutInput,
  parseMcpConnectTimeoutInput,
} from "../lib/execution-settings-form";
import { parseMcpServerForm, type McpServerForm } from "../lib/mcp-form";

/** 连接状态的中文徽标文案与配色 */
const STATUS_LABEL: Record<
  McpServerView["status"],
  { text: string; className: string }
> = {
  connected: { text: "已连接", className: "text-ok-fg" },
  connecting: { text: "连接中…", className: "text-info-fg" },
  failed: { text: "连接失败", className: "text-danger-fg" },
  disconnected: { text: "未连接", className: "text-fg-muted" },
};

const EMPTY_FORM: McpServerForm = {
  name: "",
  command: "",
  argsText: "",
  envText: "",
};

/**
 * 设置页「MCP servers」区（工单 12）：添加/删除 stdio server、
 * 连接状态与错误可见、逐工具启停（对任务即时生效）、手动重连。
 * 工具调用与连接超时两项（执行设置票 07）经 agentSettings 读写——
 * 保存后主进程逐次解析注入 manager，下一次连接/工具调用即按新值执行。
 */
export function McpSettingsSection() {
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<McpServerForm>(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);

  // MCP 超时两项（票 07）：同一 agent-settings.json 的七项执行设置中，
  // 本分区只编辑 MCP 两项；保存时其余五项读取当前最新值原样回传
  // （IPC 七字段整体形状，避免用装载快照覆盖执行分区的并发保存）
  const [callTimeout, setCallTimeout] = useState("30");
  const [connectTimeout, setConnectTimeout] = useState("15");
  const [timeoutLoaded, setTimeoutLoaded] = useState(false);
  const [timeoutSaving, setTimeoutSaving] = useState(false);
  const [timeoutMessage, setTimeoutMessage] = useState("");
  const [timeoutMessageError, setTimeoutMessageError] = useState(false);

  async function refreshTimeouts() {
    setTimeoutMessage("");
    setTimeoutMessageError(false);
    try {
      const settings = await window.codexlike.agentSettings.get();
      setCallTimeout(String(settings.mcpCallTimeoutSeconds));
      setConnectTimeout(String(settings.mcpConnectTimeoutSeconds));
      setTimeoutLoaded(true);
    } catch (error) {
      setTimeoutMessage(error instanceof Error ? error.message : String(error));
      setTimeoutMessageError(true);
    }
  }

  useEffect(() => {
    void refreshTimeouts();
  }, []);

  async function saveTimeouts() {
    if (!timeoutLoaded) return;
    setTimeoutSaving(true);
    setTimeoutMessage("");
    try {
      // 非法/越界输入回退默认值（ADR 0017）；回退值写回输入框可见。
      // 七项一次保存（同一文件的整体形状），本分区只呈现 MCP 两项的编辑。
      const current = await window.codexlike.agentSettings.get();
      const settings = await window.codexlike.agentSettings.set({
        ...current,
        mcpCallTimeoutSeconds: parseMcpCallTimeoutInput(callTimeout),
        mcpConnectTimeoutSeconds: parseMcpConnectTimeoutInput(connectTimeout),
      });
      setCallTimeout(String(settings.mcpCallTimeoutSeconds));
      setConnectTimeout(String(settings.mcpConnectTimeoutSeconds));
      setTimeoutMessage(
        `已保存：工具调用超时 ${settings.mcpCallTimeoutSeconds} 秒、连接超时 ${settings.mcpConnectTimeoutSeconds} 秒（对下一次工具调用/连接生效）`
      );
      setTimeoutMessageError(false);
    } catch (error) {
      setTimeoutMessage(error instanceof Error ? error.message : String(error));
      setTimeoutMessageError(true);
    } finally {
      setTimeoutSaving(false);
    }
  }

  async function refresh() {
    setLoadError("");
    try {
      const overview = await window.codexlike.mcp.overview();
      setServers(overview.servers);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function addServer() {
    if (servers === null) return;
    const parsed = parseMcpServerForm(form);
    if (parsed.error !== undefined) {
      setFormError(parsed.error);
      return;
    }
    setBusy(true);
    setFormError("");
    setMessage("");
    try {
      const view = await window.codexlike.mcp.addServer(parsed);
      setShowForm(false);
      setForm(EMPTY_FORM);
      setMessage(
        view.status === "connected"
          ? `已添加并连接「${view.config.name}」，发现 ${view.tools.length} 个工具`
          : `已添加「${view.config.name}」，但连接失败：${view.error ?? "未知原因"}（可稍后重连）`
      );
      setMessageError(view.status !== "connected");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function removeServer(view: McpServerView) {
    if (!window.confirm(`确定删除 MCP server「${view.config.name}」吗？`)) {
      return;
    }
    await window.codexlike.mcp.removeServer(view.config.id);
    await refresh();
  }

  async function reconnect(view: McpServerView) {
    setMessage("");
    try {
      const updated = await window.codexlike.mcp.reconnect(view.config.id);
      setMessage(
        updated.status === "connected"
          ? `「${updated.config.name}」已重连，发现 ${updated.tools.length} 个工具`
          : `「${updated.config.name}」重连失败：${updated.error ?? "未知原因"}`
      );
      setMessageError(updated.status !== "connected");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageError(true);
    }
    await refresh();
  }

  async function toggleTool(toolName: string, enabled: boolean) {
    await window.codexlike.mcp.setToolEnabled(toolName, enabled);
    await refresh();
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-medium text-fg">MCP servers</h2>
          <p className="text-xs text-fg-muted">
            stdio 方式接入第三方工具服务器（Model Context Protocol）；
            发现的工具以 mcp_
            前缀并入工具注册表，可逐工具启停（对之后的任务消息即时生效）；
            环境变量经系统加密存储。MCP
            工具按命令级权限处理——协作模式下调用会弹审批卡片。
          </p>
        </div>
        {!showForm && (
          <button
            type="button"
            data-testid="mcp-add-server"
            disabled={servers === null}
            className="rounded bg-accent px-3 py-1.5 text-sm text-on-accent hover:bg-accent-hover disabled:opacity-50"
            onClick={() => {
              setShowForm(true);
              setForm(EMPTY_FORM);
              setFormError("");
            }}
          >
            + 添加 server
          </button>
        )}
      </div>

      {!timeoutLoaded && (
        <div
          role={timeoutMessageError ? "alert" : "status"}
          className="text-sm text-fg-muted"
        >
          {timeoutMessageError ? (
            <>
              <p className="text-danger-fg">加载失败：{timeoutMessage}</p>
              <button
                type="button"
                data-testid="mcp-timeout-settings-retry"
                onClick={() => void refreshTimeouts()}
                className="mt-2 rounded border border-line px-3 py-1 hover:bg-hover"
              >
                重试
              </button>
            </>
          ) : (
            "正在加载…"
          )}
        </div>
      )}
      {timeoutLoaded && (
        <McpTimeoutSettingsBody
          callTimeout={callTimeout}
          connectTimeout={connectTimeout}
          onCallInput={setCallTimeout}
          onConnectInput={setConnectTimeout}
          onSave={() => void saveTimeouts()}
          saving={timeoutSaving}
          message={timeoutMessage}
          messageError={timeoutMessageError}
        />
      )}

      {message !== "" && (
        <p
          data-testid="mcp-settings-message"
          className={`text-xs ${messageError ? "text-danger-fg" : "text-ok-fg"}`}
        >
          {message}
        </p>
      )}

      {loadError !== "" && (
        <div role="alert" className="text-sm text-danger-fg">
          <p>加载失败：{loadError}</p>
          <button
            type="button"
            data-testid="mcp-settings-retry"
            onClick={() => void refresh()}
            className="mt-2 rounded border border-line px-3 py-1 hover:bg-hover"
          >
            重试
          </button>
        </div>
      )}
      {servers === null && loadError === "" && (
        <p role="status" className="text-sm text-fg-muted">
          正在加载…
        </p>
      )}
      <ul className="flex flex-col gap-2" data-testid="mcp-server-list">
        {(servers ?? []).map((view) => {
          const status = STATUS_LABEL[view.status];
          return (
            <li
              key={view.config.id}
              data-testid="mcp-server-item"
              data-server-name={view.config.name}
              className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-4 py-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    data-testid={`mcp-status-${view.config.name}`}
                    className={`text-xs font-medium ${status.className}`}
                  >
                    {status.text}
                  </span>
                  <p className="truncate text-sm font-medium text-fg">
                    {view.config.name}
                  </p>
                  <p className="truncate font-mono text-xs text-fg-muted">
                    {view.config.command} {view.config.args.join(" ")}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    data-testid="mcp-reconnect"
                    disabled={busy}
                    className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50"
                    onClick={() => void reconnect(view)}
                  >
                    重连
                  </button>
                  <button
                    type="button"
                    data-testid="mcp-remove"
                    className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-danger-bg hover:text-danger-fg"
                    onClick={() => void removeServer(view)}
                  >
                    删除
                  </button>
                </div>
              </div>

              {view.error !== null && view.status !== "connected" && (
                <p className="rounded border border-danger-fg/30 bg-danger-bg px-2 py-1.5 text-xs text-danger-fg">
                  {view.error}
                </p>
              )}

              {view.tools.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {view.tools.map((tool) => (
                    <li
                      key={tool.name}
                      className="flex items-center justify-between gap-2 rounded bg-code-bg px-2 py-1.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs text-accent">
                          {tool.name}
                        </p>
                        <p className="truncate text-xs text-fg-muted">
                          {tool.description}
                        </p>
                      </div>
                      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-fg-muted">
                        <input
                          type="checkbox"
                          data-testid={`mcp-tool-toggle-${tool.name}`}
                          checked={tool.enabled}
                          onChange={(e) =>
                            void toggleTool(tool.name, e.target.checked)
                          }
                        />
                        {tool.enabled ? "已启用" : "已禁用"}
                      </label>
                    </li>
                  ))}
                </ul>
              )}

              {view.status === "connected" && view.tools.length === 0 && (
                <p className="text-xs text-fg-muted">
                  已连接，但该 server 未提供任何工具
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {servers !== null && servers.length === 0 && !showForm && (
        <p className="rounded border border-dashed border-line px-4 py-6 text-center text-sm text-fg-subtle">
          还没有配置 MCP server，点击「添加 server」接入第三方工具生态
        </p>
      )}

      {showForm && (
        <div
          data-testid="mcp-server-form"
          className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-4 py-3"
        >
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              名称（决定工具前缀 mcp_名称_工具）
              <input
                data-testid="mcp-form-name"
                className="rounded border border-line bg-code-bg px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
                placeholder="如 filesystem"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              启动命令（可执行文件）
              <input
                data-testid="mcp-form-command"
                className="rounded border border-line bg-code-bg px-2 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent"
                placeholder="如 node 或 npx"
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            参数（每行一个）
            <textarea
              data-testid="mcp-form-args"
              rows={2}
              className="rounded border border-line bg-code-bg px-2 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent"
              placeholder={"server.js\n--stdio"}
              value={form.argsText}
              onChange={(e) => setForm({ ...form, argsText: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            环境变量（每行 KEY=VALUE；经加密存储）
            <textarea
              data-testid="mcp-form-env"
              rows={2}
              className="rounded border border-line bg-code-bg px-2 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent"
              placeholder={"API_TOKEN=xxx\nDEBUG=1"}
              value={form.envText}
              onChange={(e) => setForm({ ...form, envText: e.target.value })}
            />
          </label>
          {formError !== "" && (
            <p className="text-xs text-danger-fg">{formError}</p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded px-3 py-1.5 text-sm text-fg-muted hover:bg-hover"
              onClick={() => {
                setShowForm(false);
                setFormError("");
              }}
            >
              取消
            </button>
            <button
              type="button"
              formNoValidate
              data-testid="mcp-form-submit"
              disabled={busy}
              className="rounded bg-accent px-3 py-1.5 text-sm text-on-accent hover:bg-accent-hover disabled:opacity-50"
              onClick={() => void addServer()}
            >
              {busy ? "连接中…" : "保存并连接"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * MCP 超时表体（执行设置票 07，容器/表体分离同 ExecutionSettingsBody 先例，
 * 便于静态渲染测试）：工具调用超时与连接超时两项数字输入 + 一次保存。
 * 非法输入在保存时经解析函数回退默认值并写回（与执行分区同语义）；
 * 超时以秒呈现与存储，宿主侧换算毫秒注入 manager。
 */
export function McpTimeoutSettingsBody(props: {
  /** 输入框当前文本（容器持有，便于回退默认后写回展示） */
  callTimeout: string;
  connectTimeout: string;
  onCallInput: (value: string) => void;
  onConnectInput: (value: string) => void;
  onSave: () => void;
  saving: boolean;
  message: string;
  messageError: boolean;
}) {
  return (
    <div
      data-testid="mcp-timeout-settings"
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3"
    >
      <label className="flex flex-col gap-1 text-sm text-fg-muted">
        工具调用超时（5-300 秒）
        <input
          type="number"
          min={5}
          max={300}
          step={1}
          data-testid="mcp-call-timeout-input"
          className="w-32 rounded border border-line bg-code-bg px-2 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent"
          value={props.callTimeout}
          onChange={(e) => props.onCallInput(e.target.value)}
        />
        <span className="text-xs text-fg-subtle">
          等待 MCP 工具执行返回的时限（默认 30）；慢外部 server
          可调大，改动对下一次工具调用生效。
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm text-fg-muted">
        连接超时（5-120 秒）
        <input
          type="number"
          min={5}
          max={120}
          step={1}
          data-testid="mcp-connect-timeout-input"
          className="w-32 rounded border border-line bg-code-bg px-2 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent"
          value={props.connectTimeout}
          onChange={(e) => props.onConnectInput(e.target.value)}
        />
        <span className="text-xs text-fg-subtle">
          建立 server 连接（启动进程 + 握手 + 工具发现）的时限（默认
          15）；慢启动的 server 可调大，改动对下一次连接生效。
        </span>
      </label>

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          data-testid="mcp-timeout-settings-save"
          disabled={props.saving}
          className="rounded bg-accent px-3 py-1.5 text-sm text-on-accent hover:bg-accent-hover disabled:opacity-50"
          onClick={props.onSave}
        >
          {props.saving ? "保存中…" : "保存"}
        </button>
        {props.message !== "" && (
          <p
            data-testid="mcp-timeout-settings-message"
            className={`text-xs ${props.messageError ? "text-danger-fg" : "text-ok-fg"}`}
          >
            {props.message}
          </p>
        )}
      </div>
    </div>
  );
}
