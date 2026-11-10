import { useEffect, useState } from 'react';

import type { ProviderProfile } from '@codexlike/agent-core';

import { ProviderProfileForm } from '../components/ProviderProfileForm';

/** 编辑中态：'new' 新建；其余为正在编辑的 Profile id */
type Editing = 'new' | string | null;

/** 设置页：Provider Profile 的增删改查 + 搜索源配置（其余设置项随后续工单扩展） */
export function SettingsPage() {
  const [profiles, setProfiles] = useState<ProviderProfile[] | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [loadError, setLoadError] = useState('');

  async function refresh() {
    try {
      setProfiles(await window.codexlike.providerProfiles.list());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setProfiles([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const editingProfile =
    editing !== null && editing !== 'new'
      ? (profiles?.find((p) => p.id === editing) ?? null)
      : null;

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col gap-4 overflow-y-auto p-6">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-medium text-slate-200">
              Provider Profiles
            </h2>
            <p className="text-xs text-slate-500">
              OpenAI 兼容端点（baseURL + API Key + 模型）；API Key 经系统加密存储，磁盘上无明文
            </p>
          </div>
          {editing === null && (
            <button
              type="button"
              className="rounded bg-sky-700 px-3 py-1.5 text-sm text-white hover:bg-sky-600"
              onClick={() => setEditing('new')}
            >
              + 新建 Profile
            </button>
          )}
        </div>

        {loadError !== '' && (
          <p className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-400">
            加载失败：{loadError}
          </p>
        )}

        <ul className="flex flex-col gap-2">
          {(profiles ?? []).map((profile) => (
            <li
              key={profile.id}
              className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3"
            >
              {editing === profile.id && editingProfile !== null ? (
                <div className="flex-1">
                  <ProviderProfileForm
                    initial={{
                      name: editingProfile.name,
                      baseURL: editingProfile.baseURL,
                      apiKey: editingProfile.apiKey,
                      model: editingProfile.model,
                    }}
                    submitLabel="保存修改"
                    onCancel={() => setEditing(null)}
                    onSubmit={async (input) => {
                      await window.codexlike.providerProfiles.update(
                        profile.id,
                        input,
                      );
                      setEditing(null);
                      await refresh();
                    }}
                  />
                </div>
              ) : (
                <>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-200">
                      {profile.name}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {profile.baseURL} · {profile.model}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                      onClick={() => setEditing(profile.id)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-red-950 hover:text-red-400"
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

        {editing === 'new' && (
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
          <p className="rounded border border-dashed border-slate-800 px-4 py-6 text-center text-sm text-slate-600">
            还没有 Provider Profile，点击「新建 Profile」配置第一个模型接入
          </p>
        )}
      </section>

      <SearchSettingsSection />
      <SubagentSettingsSection />
    </div>
  );
}

/**
 * 子代理全局配置区（工单 13，GLOSSARY「子代理」）：
 * 子代理模型（Provider Profile 引用；默认同主模型）+ 并发上限（默认 3，1-8）。
 * 保存后对后续会话/下一次委派即时生效（主进程逐次解析内存缓存）。
 */
function SubagentSettingsSection() {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [providerProfileId, setProviderProfileId] = useState<string>('');
  const [maxConcurrent, setMaxConcurrent] = useState('3');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [messageError, setMessageError] = useState(false);

  async function refresh() {
    try {
      const [profileList, settings] = await Promise.all([
        window.codexlike.providerProfiles.list(),
        window.codexlike.subagentSettings.get(),
      ]);
      setProfiles(profileList);
      // 空串 = 同主模型（默认）；引用的 Profile 已删除时回落为同主模型
      const valid =
        settings.providerProfileId !== null &&
        profileList.some((p) => p.id === settings.providerProfileId);
      setProviderProfileId(valid ? settings.providerProfileId! : '');
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

  async function save() {
    setSaving(true);
    setMessage('');
    try {
      const settings = await window.codexlike.subagentSettings.set({
        providerProfileId: providerProfileId === '' ? null : providerProfileId,
        maxConcurrent: Number(maxConcurrent),
      });
      setMaxConcurrent(String(settings.maxConcurrent));
      setMessage('子代理设置已保存（对后续会话与下一次委派生效）');
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
        <h2 className="text-base font-medium text-slate-200">子代理</h2>
        <p className="text-xs text-slate-500">
          spawn_subagent 委派的子代理使用的模型与并发上限。子代理拥有独立上下文与完整工具集
          （不可再委派子代理）；并发上限外的委派将排队等待。
        </p>
      </div>

      {loaded && (
        <div
          data-testid="subagent-settings"
          className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3"
        >
          <label className="flex flex-col gap-1 text-sm text-slate-300">
            子代理模型
            <select
              data-testid="subagent-profile-select"
              className="rounded border border-slate-700 bg-slate-950/70 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-sky-600"
              value={providerProfileId}
              onChange={(e) => setProviderProfileId(e.target.value)}
            >
              <option value="">同主模型（每次委派沿用当前会话所选模型）</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} · {profile.model}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm text-slate-300">
            并发上限（1-8）
            <input
              type="number"
              min={1}
              max={8}
              step={1}
              data-testid="subagent-concurrency-input"
              className="w-32 rounded border border-slate-700 bg-slate-950/70 px-2 py-1.5 font-mono text-sm text-slate-200 outline-none focus:border-sky-600"
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(e.target.value)}
            />
          </label>

          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid="subagent-settings-save"
              disabled={saving}
              className="rounded bg-sky-700 px-3 py-1.5 text-sm text-white hover:bg-sky-600 disabled:opacity-50"
              onClick={() => void save()}
            >
              {saving ? '保存中…' : '保存'}
            </button>
            {message !== '' && (
              <p
                data-testid="subagent-settings-message"
                className={`text-xs ${messageError ? 'text-red-400' : 'text-emerald-400'}`}
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

/** 搜索源配置区（工单 10）：默认 Tavily；key 经 safeStorage 加密存储，改完对进行中的会话即时生效 */
function SearchSettingsSection() {
  const [apiKey, setApiKey] = useState('');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [messageError, setMessageError] = useState(false);

  async function refresh() {
    try {
      const settings = await window.codexlike.searchSettings.get();
      setApiKey(settings.apiKey);
      setConfigured(settings.apiKey !== '');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageError(true);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save(nextKey: string) {
    setSaving(true);
    setMessage('');
    try {
      const settings = await window.codexlike.searchSettings.set({ apiKey: nextKey });
      setApiKey(settings.apiKey);
      setConfigured(settings.apiKey !== '');
      setMessage(nextKey === '' ? '已清除搜索源配置' : '搜索源已保存，web_search 可用');
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
        <h2 className="text-base font-medium text-slate-200">搜索源</h2>
        <p className="text-xs text-slate-500">
          web_search 工具使用的搜索服务（默认 Tavily，https://tavily.com 注册，免费 1000
          次/月）；API key 经系统加密存储。配置后无需重启会话即可生效。
        </p>
      </div>

      {configured !== null && (
        <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-sky-300">
              Tavily
            </span>
            <span className={configured ? 'text-emerald-400' : 'text-amber-400'}>
              {configured ? '已配置' : '未配置（web_search 将提示先在设置页填写 key）'}
            </span>
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              data-testid="search-api-key-input"
              className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950/70 px-2 py-1.5 font-mono text-sm text-slate-200 outline-none focus:border-sky-600"
              placeholder="Tavily API key（tvly-…）"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button
              type="button"
              data-testid="search-api-key-save"
              disabled={saving || apiKey.trim() === ''}
              className="rounded bg-sky-700 px-3 py-1.5 text-sm text-white hover:bg-sky-600 disabled:opacity-50"
              onClick={() => void save(apiKey.trim())}
            >
              {saving ? '保存中…' : '保存'}
            </button>
            {configured && (
              <button
                type="button"
                disabled={saving}
                className="rounded px-3 py-1.5 text-sm text-slate-400 hover:bg-red-950 hover:text-red-400 disabled:opacity-50"
                onClick={() => void save('')}
              >
                清除
              </button>
            )}
          </div>
          {message !== '' && (
            <p
              data-testid="search-settings-message"
              className={`text-xs ${messageError ? 'text-red-400' : 'text-emerald-400'}`}
            >
              {message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
