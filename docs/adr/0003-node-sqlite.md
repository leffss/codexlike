# node:sqlite 而非 better-sqlite3

会话持久化选用 Node 内置的 `node:sqlite`（Electron 45 内置 Node 24，实测可用），放弃 spec 初稿中的 `better-sqlite3`：native 模块在 pnpm 单副本 store 下无法同时满足系统 Node（vitest 运行时）与 Electron 两套 ABI，双份编译维护成本高。实质要求不变——仍是 SQLite 文件库，且经 `SessionPersistence` 接口注入（`createSqliteSessionStore`），测试用 `:memory:`。附带约束：agent-core 的 Node 专属代码走 `./node` 子出口，主出口保持浏览器安全（见工单 02 Comments 的双出口拆分）。
