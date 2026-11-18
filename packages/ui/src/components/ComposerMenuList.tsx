import type { SlashCommandDef, SkillDescriptor } from "@codexlike/agent-core";
import type { ComposerMenuState } from "../lib/composer-menu";

/**
 * 输入框补全菜单列表（`/` 命令 · `@` 文件引用 · `$` 技能）：
 * 从 MessageComposer 原样移出的渲染件（票 01 抽共享）——正式任务 composer
 * 与新建起点页输入卡共用同一菜单呈现（testid 与条目结构不变）；
 * 键盘导航与状态归 composer-menu lib 与宿主输入组件。
 */
export function ComposerMenuList(props: {
  menu: ComposerMenuState;
  /** 选中条目：宿主以当前光标位置写回文本 */
  onSelectItem: (
    item: ComposerMenuState["items"][number],
    caretIndex: number
  ) => void;
  /** 宿主输入框的当前光标位置（点击菜单项时光标读取） */
  caretIndex: () => number;
}) {
  const { menu } = props;
  return (
    <ul
      data-testid="composer-menu"
      role="listbox"
      aria-label={menu.kind === "skills" ? "下轮技能预览" : "输入补全"}
      className="absolute bottom-full left-0 z-10 mb-2 max-h-56 w-full overflow-y-auto rounded-xl border border-line bg-surface shadow-xl"
    >
      {menu.items.map((item, index) => {
        const isCommand = menu.kind === "slash-commands";
        const command = isCommand ? (item as SlashCommandDef) : null;
        const skill = menu.kind === "skills" ? (item as SkillDescriptor) : null;
        const path = menu.kind === "mentions" ? (item as string) : null;
        return (
          <li
            key={command?.name ?? skill?.path ?? path}
            role="option"
            aria-selected={index === menu.activeIndex}
            data-testid={skill ? `composer-skill-${skill.name}` : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onSelectItem(item, props.caretIndex())}
            className={
              index === menu.activeIndex
                ? "bg-selected px-3 py-1.5 text-sm text-fg"
                : "px-3 py-1.5 text-sm text-fg-muted hover:bg-hover"
            }
          >
            {command !== null ? (
              <span className="flex items-baseline gap-2">
                <code className="text-accent">/{command.name}</code>
                <span className="text-xs text-fg-subtle">
                  {command.description}
                  {command.argumentHint !== null
                    ? `（参数：${command.argumentHint}）`
                    : ""}
                </span>
              </span>
            ) : skill !== null ? (
              <span className="block" title={skill.path}>
                <code className="text-accent">${skill.name}</code>
                <span className="ml-2 text-xs text-fg-muted">
                  {skill.description}
                </span>
                <span className="block truncate text-xs text-fg-subtle">
                  下轮预览 · {skill.scope === "project" ? "项目" : "全局"} ·{" "}
                  {skill.source} · {skill.path}
                </span>
              </span>
            ) : (
              <span
                className="block truncate font-mono text-xs"
                title={path ?? ""}
              >
                {path}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
