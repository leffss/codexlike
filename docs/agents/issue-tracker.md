# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- 多票实现开始前，把探索事实（布局结构 / 依赖面 / repo 约定）沉淀为 `.scratch/<feature-slug>/notes.md`，各实现票以指针复用，避免每个 implementer 重复探索（2026-11-14 ui-redesign 起为惯例）；定位写符号名（函数/组件/表名）配验证性 grep 提示而非行号——行号随各票合入漂移（2026-11-17 subagent-work-plan 轮 retro）
- 多票由子代理编排实现时，实现者完成时在**下游票面** Comments 追加衔接注意事项（接入点标记、勿复用的陷阱、testid/交互面变更），编排者把实现者报告里的下游信息转抄落票面——这是子代理间唯一的衔接通道，替代跨子代理通信（2026-11-18 new-task-start 轮五票串并链验证）
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings); 关单置 `Status: done` 时逐条勾选票面验收 checkbox——验收明细落票面可检视，不只散在 implementer 汇报里（2026-11-17 retro）
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
