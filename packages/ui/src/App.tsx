import { useState } from 'react';

import { SettingsPage } from './pages/SettingsPage';
import { WorkspacePage } from './pages/WorkspacePage';

type View = 'workspace' | 'settings';

export function App() {
  const [view, setView] = useState<View>('workspace');

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-wide text-slate-200">
            CodexLike
          </span>
          <span className="text-xs text-slate-500">本地 AI coding agent 工作台</span>
        </div>
        <nav className="flex items-center gap-1">
          {view === 'settings' ? (
            <button
              type="button"
              className="rounded px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
              onClick={() => setView('workspace')}
            >
              返回工作台
            </button>
          ) : (
            <button
              type="button"
              className="rounded px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
              onClick={() => setView('settings')}
            >
              设置
            </button>
          )}
        </nav>
      </header>

      <main className="min-h-0 flex-1">
        {view === 'workspace' ? (
          <WorkspacePage onOpenSettings={() => setView('settings')} />
        ) : (
          <SettingsPage />
        )}
      </main>
    </div>
  );
}
