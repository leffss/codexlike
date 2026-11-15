import type {
  ResourceSnapshotSummary as SnapshotSummaryData,
  SkillDescriptor,
} from "@codexlike/agent-core";

/**
 * 资源快照摘要（右栏「规范与技能」tab 内容，prototype/panels-redesign
 * 变体 A 折叠）：单份快照的密排渲染——元信息 → AGENTS 来源 → 技能
 * （状态点）→ 已加载 → 诊断；配 SnapshotSwitcher 在三档快照间切换
 * （本轮 active / 上轮 last / 下轮预览 preview，GLOSSARY「资源快照」）。
 * 取代原 AgentResourcesPanel 的三卡片重复结构：三档共用同一渲染器，
 * 档位切换而非同屏堆叠。
 */

/** 三档快照 key 与短名（右栏 chips 文案） */
export const SNAPSHOT_TABS: readonly { key: SnapshotKey; label: string }[] = [
  { key: "active", label: "本轮" },
  { key: "last", label: "上轮" },
  { key: "preview", label: "下轮预览" },
] as const;

export type SnapshotKey = "active" | "last" | "preview";

/** 技能状态 → 状态点颜色（点 + 文字双通道，色弱可读） */
const SKILL_STATUS_DOT: Record<SkillDescriptor["status"], string> = {
  active: "bg-ok-fg",
  shadowed: "bg-warn-fg",
  invalid: "bg-danger-fg",
  excluded: "bg-fg-subtle",
};

const SKILL_STATUS_TEXT: Record<SkillDescriptor["status"], string> = {
  active: "有效",
  shadowed: "已覆盖",
  invalid: "无效",
  excluded: "已排除",
};

/** 三档快照切换 chips（紧凑分段控件） */
export function SnapshotSwitcher(props: {
  value: SnapshotKey;
  onChange: (key: SnapshotKey) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="快照档位"
      data-testid="snapshot-switcher"
      className="flex shrink-0 gap-1 rounded border border-line bg-surface-muted p-0.5"
    >
      {SNAPSHOT_TABS.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={props.value === key}
          data-testid={`snapshot-tab-${key}`}
          onClick={() => props.onChange(key)}
          className={`rounded px-2 py-0.5 text-xs ${
            props.value === key
              ? "bg-accent/15 font-medium text-accent"
              : "text-fg-muted hover:text-fg"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** 单份快照摘要（三档共用；只读元数据，不读取或展开正文） */
export function SnapshotSummary(props: { summary: SnapshotSummaryData }) {
  const summary = props.summary;
  return (
    <div data-testid="snapshot-summary" className="space-y-3 text-xs">
      <p className="break-all text-fg-subtle">
        采集于 {summary.catalog.capturedAt} · 约 {summary.estimatedTokens}{" "}
        tokens · 索引 {summary.catalog.indexBytes} 字节
      </p>
      {summary.catalog.agents.truncated && (
        <p className="text-warn-fg">AGENTS 总量超 32 KiB，已截断</p>
      )}
      <section className="space-y-1">
        <h4 className="font-medium text-fg">
          AGENTS 来源（{summary.catalog.agents.sources.length}）
        </h4>
        {summary.catalog.agents.sources.length === 0 && (
          <p className="text-fg-subtle">未发现规范</p>
        )}
        {summary.catalog.agents.sources.map((source) => (
          <p key={source.path} className="break-all text-fg-muted">
            {source.scope === "project" ? "项目" : "全局"} ·{" "}
            <code className="text-fg">{source.path}</code> · 纳入{" "}
            {source.includedBytes}/{source.bytes} 字节
          </p>
        ))}
      </section>
      <section className="space-y-1">
        <h4 className="font-medium text-fg">
          技能（{summary.catalog.skills.length}）
        </h4>
        {summary.catalog.skills.length === 0 && (
          <p className="text-fg-subtle">未发现技能</p>
        )}
        {summary.catalog.skills.map((skill, index) => (
          <div
            key={`${skill.path}:${index}`}
            className="break-all leading-relaxed"
          >
            <span
              className={`mr-1.5 inline-block h-2 w-2 rounded-full align-middle ${SKILL_STATUS_DOT[skill.status]}`}
              aria-hidden="true"
            />
            <span className="font-medium text-fg">${skill.name}</span>
            <span className="ml-1.5 text-fg-subtle">
              {SKILL_STATUS_TEXT[skill.status]} ·{" "}
              {skill.scope === "project" ? "项目" : "全局"}
            </span>
            <p className="text-fg-muted">{skill.description}</p>
            {skill.reason !== undefined && skill.reason !== null && (
              <p className="text-warn-fg">{skill.reason}</p>
            )}
          </div>
        ))}
      </section>
      <section className="space-y-1">
        <h4 className="font-medium text-fg">
          已加载（{summary.loaded.length}）
        </h4>
        {summary.loaded.length === 0 && (
          <p className="text-fg-subtle">无已加载正文或文本资源</p>
        )}
        {summary.loaded.map((record, index) => (
          <p
            key={`${record.executorId}:${record.path}:${index}`}
            className="break-all text-fg-muted"
          >
            <span className="text-info-fg">{record.executorId}</span> · $
            {record.name} · {record.kind === "skill" ? "技能正文" : "文本资源"}{" "}
            · {record.bytes} 字节
          </p>
        ))}
      </section>
      {summary.catalog.diagnostics.length > 0 && (
        <section className="space-y-1">
          <h4 className="font-medium text-warn-fg">
            诊断（{summary.catalog.diagnostics.length}）
          </h4>
          {summary.catalog.diagnostics.map((diagnostic, index) => (
            <p key={index} className="break-all text-warn-fg">
              {diagnostic.path}：{diagnostic.message}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
