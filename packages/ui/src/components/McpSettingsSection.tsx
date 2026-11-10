import { useEffect, useState } from 'react';

import type { McpServerView } from '@codexlike/desktop/ipc';

import {
  formatEnvText,
  parseMcpServerForm,
  type McpServerForm,
} from '../lib/mcp-form';

/** 连接状态的中文徽标文案与配色 */
const STATUS_LABEL: Record<
  McpServerView['status'],
  { text: string; className: string }
> = {
  connected: { text: '已连接', className: 'text-emerald-400' },
  connecting: { text: '连接中…', className: 'text-sky-400' },
  failed: { text: '连接失败', className: 'text-red-400' },
  disconnected: { text: '未连接', className: 'text-slate-500' },
};

const EMPTY_FORM: McpServerForm = {
  name: '',
  command: '',
  argsText: '',
  envText: '',
};

/**
 * 设置页「MCP servers」区（工单 12）：添加/删除 stdio server、
 * 连接状态与错误可见、逐工具启停（对会话即时生效）、手动重连。
 */
export function McpSettingsSection() {
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<McpServerForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageError, setMessageError] = useState(false);

  async function refresh() {
    try {
      const overview = await window.codexlike.mcp.overview();
      setServers(overview.servers);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageError(true);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function addServer() {
    const parsed = parseMcpServerForm(form);
    if (parsed.error !== undefined) {
      setFormError(parsed.error);
      return;
    }
    setBusy(true);
    setFormError('');
    setMessage('');
    try {
      const view = await window.codexlike.mcp.addServer(parsed);
      setShowForm(false);
      setForm(EMPTY_FORM);
      setMessage(
        view.status === 'connected'
          ? `已添加并连接「${view.config.name}」，发现 ${view.tools.length} 个工具`
          : `已添加「${view.config.name}」，但连接失败：${view.error ?? '未知原因'}（可稍后重连）`,
      );
      setMessageError(view.status !== 'connected');
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
    setMessage('');
    try {
      const updated = await window.codexlike.mcp.reconnect(view.config.id);
      setMessage(
        updated.status === 'connected'
          ? `「${updated.config.name}」已重连，发现 ${updated.tools.length} 个工具`
          : `「${updated.config.name}」重连失败：${updated.error ?? '未知原因'}`,
      );
      setMessageError(updated.status !== 'connected');
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
          <h2 className="text-base font-medium text-slate-200">MCP servers</h2>
          <p className="text-xs text-slate-500">
            stdio 方式接入第三方工具服务器（Model Context Protocol）；
            发现的工具以 mcp_ 前缀并入工具注册表，可逐工具启停（对之后的会话消息即时生效）；
            环境变量经系统加密存储。MCP 工具按命令级权限处理——协作模式下调用会弹审批卡片。
          </p>
        </div>
        {!showForm && (
          <button
            type="button"
            data-testid="mcp-add-server"
            className="rounded bg-sky-700 px-3 py-1.5 text-sm text-white hover:bg-sky-600"
            onClick={() => {
              setShowForm(true);
              setForm(EMPTY_FORM);
              setFormError('');
            }}
          >
            + 添加 server
          </button>
        )}
      </div>

      {message !== '' && (
        <p
          data-testid="mcp-settings-message"
          className={`text-xs ${messageError ? 'text-red-400' : 'text-emerald-400'}`}
        >
          {message}
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
              className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    data-testid={`mcp-status-${view.config.name}`}
                    className={`text-xs font-medium ${status.className}`}
                  >
                    {status.text}
                  </span>
                  <p className="truncate text-sm font-medium text-slate-200">
                    {view.config.name}
                  </p>
                  <p className="truncate font-mono text-xs text-slate-500">
                    {view.config.command} {view.config.args.join(' ')}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    data-testid="mcp-reconnect"
                    disabled={busy}
                    className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-50"
                    onClick={() => void reconnect(view)}
                  >
                    重连
                  </button>
                  <button
                    type="button"
                    data-testid="mcp-remove"
                    className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-red-950 hover:text-red-400"
                    onClick={() => void removeServer(view)}
                  >
                    删除
                  </button>
                </div>
              </div>

              {view.error !== null && view.status !== 'connected' && (
                <p className="rounded border border-red-900/60 bg-red-950/40 px-2 py-1.5 text-xs text-red-400">
                  {view.error}
                </p>
              )}

              {view.tools.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {view.tools.map((tool) => (
                    <li
                      key={tool.name}
                      className="flex items-center justify-between gap-2 rounded bg-slate-950/60 px-2 py-1.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs text-sky-300">
                          {tool.name}
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          {tool.description}
                        </p>
                      </div>
                      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-slate-400">
                        <input
                          type="checkbox"
                          data-testid={`mcp-tool-toggle-${tool.name}`}
                          checked={tool.enabled}
                          onChange={(e) =>
                            void toggleTool(tool.name, e.target.checked)
                          }
                        />
                        {tool.enabled ? '已启用' : '已禁用'}
                      </label>
                    </li>
                  ))}
                </ul>
              )}

              {view.status === 'connected' && view.tools.length === 0 && (
                <p className="text-xs text-slate-500">
                  已连接，但该 server 未提供任何工具
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {servers !== null && servers.length === 0 && !showForm && (
        <p className="rounded border border-dashed border-slate-800 px-4 py-6 text-center text-sm text-slate-600">
          还没有配置 MCP server，点击「添加 server」接入第三方工具生态
        </p>
      )}

      {showForm && (
        <div
          data-testid="mcp-server-form"
          className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3"
        >
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs text-slate-400">
              名称（决定工具前缀 mcp_名称_工具）
              <input
                data-testid="mcp-form-name"
                className="rounded border border-slate-700 bg-slate-950/70 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-sky-600"
                placeholder="如 filesystem"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-400">
              启动命令（可执行文件）
              <input
                data-testid="mcp-form-command"
                className="rounded border border-slate-700 bg-slate-950/70 px-2 py-1.5 font-mono text-sm text-slate-200 outline-none focus:border-sky-600"
                placeholder="如 node 或 npx"
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            参数（每行一个）
            <textarea
              data-testid="mcp-form-args"
              rows={2}
              className="rounded border border-slate-700 bg-slate-950/70 px-2 py-1.5 font-mono text-sm text-slate-200 outline-none focus:border-sky-600"
              placeholder={'server.js\n--stdio'}
              value={form.argsText}
              onChange={(e) => setForm({ ...form, argsText: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            环境变量（每行 KEY=VALUE；经加密存储）
            <textarea
              data-testid="mcp-form-env"
              rows={2}
              className="rounded border border-slate-700 bg-slate-950/70 px-2 py-1.5 font-mono text-sm text-slate-200 outline-none focus:border-sky-600"
              placeholder={'API_TOKEN=xxx\nDEBUG=1'}
              value={form.envText}
              onChange={(e) => setForm({ ...form, envText: e.target.value })}
            />
          </label>
          {formError !== '' && (
            <p className="text-xs text-red-400">{formError}</p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              formNoValidate
              data-testid="mcp-form-submit"
              disabled={busy}
              className="rounded bg-sky-700 px-3 py-1.5 text-sm text-white hover:bg-sky-600 disabled:opacity-50"
              onClick={() => void addServer()}
            >
              {busy ? '连接中…' : '保存并连接'}
            </button>
            <button
              type="button"
              className="rounded px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800"
              onClick={() => {
                setShowForm(false);
                setFormError('');
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** 编辑表单的 env 回显辅助（配置对象 → 文本） */
export function envTextOf(view: McpServerView): string {
  return formatEnvText(view.config.env);
}
