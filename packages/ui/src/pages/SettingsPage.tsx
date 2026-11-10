import { useEffect, useState } from 'react';

import type { ProviderProfile } from '@codexlike/agent-core';

import { ProviderProfileForm } from '../components/ProviderProfileForm';

/** 编辑中态：'new' 新建；其余为正在编辑的 Profile id */
type Editing = 'new' | string | null;

/** 设置页：Provider Profile 的增删改查（其余设置项随后续工单扩展） */
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
    </div>
  );
}
