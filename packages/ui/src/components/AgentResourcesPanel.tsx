import type {
  ResourceSnapshotSummary,
  SessionResourcesView,
  SkillDescriptor,
} from "@codexlike/agent-core";

const STATUS_LABELS: Record<SkillDescriptor["status"], string> = {
  active: "有效",
  shadowed: "已覆盖",
  invalid: "无效",
  excluded: "已排除",
};

/** 只显示资源元数据；不读取或展开 AGENTS/技能正文。 */
export function AgentResourcesPanel(props: {
  resources: SessionResourcesView | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <aside
      data-testid="resources-panel"
      aria-label="规范与技能"
      className="flex w-96 shrink-0 flex-col border-l border-line bg-surface-muted text-sm text-fg"
    >
      <header className="flex items-center gap-2 border-b border-line p-3">
        <h2 className="flex-1 font-medium">规范与技能</h2>
        <button
          type="button"
          onClick={props.onRefresh}
          disabled={props.loading}
          className="text-xs text-accent disabled:opacity-50"
        >
          刷新预览
        </button>
        <button
          type="button"
          onClick={props.onClose}
          className="text-xs text-fg-muted"
        >
          关闭
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <p className="text-xs text-fg-subtle">
          只读元数据，不展示正文。技能按需加载，仅本轮生效；预览不代表当前已加载。
        </p>
        {props.loading && (
          <p role="status" className="text-fg-muted">
            正在刷新资源…
          </p>
        )}
        {props.error !== null && (
          <p role="alert" className="text-danger-fg">
            {props.error}
          </p>
        )}
        {props.resources === null ? (
          !props.loading &&
          props.error === null && <p className="text-fg-muted">暂无资源信息</p>
        ) : (
          <>
            <Snapshot
              title="当前运行快照（active）"
              summary={props.resources.active}
              empty="当前没有运行中的资源快照"
            />
            <Snapshot
              title="最近一轮摘要（last）"
              summary={props.resources.last}
              empty="尚无最近一轮摘要"
            />
            <Snapshot
              title="下轮磁盘预览（preview）"
              summary={props.resources.preview}
              empty="暂无预览"
            />
          </>
        )}
      </div>
    </aside>
  );
}

function Snapshot(props: {
  title: string;
  summary: ResourceSnapshotSummary | null;
  empty: string;
}) {
  const summary = props.summary;
  return (
    <section className="space-y-2 rounded-lg border border-line bg-surface p-3">
      <h3 className="font-medium">{props.title}</h3>
      {summary === null ? (
        <p className="text-xs text-fg-subtle">{props.empty}</p>
      ) : (
        <>
          <p className="break-all text-xs text-fg-subtle">
            采集于 {summary.catalog.capturedAt} · 约 {summary.estimatedTokens}{" "}
            tokens · 索引 {summary.catalog.indexBytes} 字节
          </p>
          <h4 className="text-xs font-medium">AGENTS.md</h4>
          {summary.catalog.agents.truncated && (
            <p className="text-xs text-warn-fg">总量超 32 KiB，已截断</p>
          )}
          {summary.catalog.agents.sources.length === 0 && (
            <p className="text-xs text-fg-subtle">未发现规范</p>
          )}
          <ul className="space-y-2 text-xs">
            {summary.catalog.agents.sources.map((source) => (
              <li key={source.path} className="break-all">
                <code>{source.path}</code>
                <div className="text-fg-subtle">
                  {source.scope === "project" ? "项目" : "全局"} · 已纳入{" "}
                  {source.includedBytes} / {source.bytes} 字节
                </div>
              </li>
            ))}
          </ul>
          <h4 className="text-xs font-medium">技能来源与状态</h4>
          {summary.catalog.skills.length === 0 && (
            <p className="text-xs text-fg-subtle">未发现技能</p>
          )}
          <ul className="space-y-2 text-xs">
            {summary.catalog.skills.map((skill, index) => (
              <li key={`${skill.path}:${index}`} className="break-all">
                <span className="font-medium">${skill.name}</span> ·{" "}
                {STATUS_LABELS[skill.status]}（{skill.status}）
                <p className="text-fg-muted">{skill.description}</p>
                <p className="text-fg-subtle">
                  {skill.scope === "project" ? "项目" : "全局"} · {skill.source}{" "}
                  · {skill.path}
                </p>
                {skill.reason && <p className="text-warn-fg">{skill.reason}</p>}
              </li>
            ))}
          </ul>
          <h4 className="text-xs font-medium">已加载（按执行者独立记录）</h4>
          {summary.loaded.length === 0 && (
            <p className="text-xs text-fg-subtle">无已加载正文或文本资源</p>
          )}
          <ul className="space-y-2 text-xs">
            {summary.loaded.map((record, index) => (
              <li
                key={`${record.executorId}:${record.path}:${index}`}
                className="break-all"
              >
                <span className="text-info-fg">执行者 {record.executorId}</span>{" "}
                · ${record.name} ·{" "}
                {record.kind === "skill" ? "技能正文" : "文本资源"} ·{" "}
                {record.bytes} 字节
                <p className="text-fg-subtle">{record.path}</p>
              </li>
            ))}
          </ul>
          <h4 className="text-xs font-medium">诊断</h4>
          {summary.catalog.diagnostics.length === 0 && (
            <p className="text-xs text-fg-subtle">无诊断</p>
          )}
          <ul className="space-y-1 text-xs text-warn-fg">
            {summary.catalog.diagnostics.map((diagnostic, index) => (
              <li key={index} className="break-all">
                {diagnostic.path}：{diagnostic.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
