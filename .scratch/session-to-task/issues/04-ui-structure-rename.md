# 04: UI 结构改名（文案与 testid 暂留）

术语依据换词后的 `GLOSSARY.md`；上游票 03 已就位（新 channel + 旧名兼容）。

**What to build:** 渲染层组件、状态与 lib 模块的标识符/文件名全部更名 task 系，`window.codexlike` 调用切到新 task 系命名空间与 channel；用户可见中文文案与 data-testid 值**本票一律不动**，保证 e2e 与文案断言不红。

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] `Session*` 系组件（侧栏、右键菜单、活跃徽标、搜索、归属对话框等 6 个）文件与导出名更名 task 系
- [ ] 状态与 lib 模块更名：工作台页、外部 store、live 事件接续、消息段模型、项目分组、斜杠命令编排、workspace-state 等 session 系命名
- [ ] 渲染层全部 `window.codexlike` API 调用切到 task 系命名空间/channel（兼容层仍在，但 UI 侧一步到位）
- [ ] 用户可见中文文案与 data-testid 值保持旧值不动（票 05 统一换词）
- [ ] UI 全部测试改绿（侧栏 UI、消息段、live、自动批准、项目分组、队列条等）；architecture 守卫通过
- [ ] e2e 在本票结束时保持全绿（不动断言的前提下）
