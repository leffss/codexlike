# 09: 托管 Worktree

**What to build:** 新建会话时可选运行位置：「本目录直跑」（默认）或「worktree 模式」——CodexLike 在 `~/.codexlike/worktrees/<会话id>` 自动创建 git worktree 与独立分支 `codexlike/<会话id>`，会话的全部文件与终端操作发生在隔离副本中；项目内 `.worktreeinclude` 文件列出的被 ignore 文件（如 `.env`）在创建时复制进副本。会话结束（删除/归档）后 worktree 进入 LRU 清理：只保留最近 15 个，运行中会话的 worktree 永不清理。非 git 目录选 worktree 模式时明确报错。验收场景 5：同一仓库一本地会话 + 一 worktree 会话并行改动互不干扰。

遵循 `GLOSSARY.md`（术语：托管 Worktree）；完整需求见 `.scratch/codexlike-v1/spec.md`。不做 local↔worktree 中途迁移（handoff）。

**Blocked by:** 05 (改动面板 + git 集成), 06 (会话恢复 + 打断)

**Status:** done

- [x] 新会话可选模式；worktree 创建于约定目录、独立分支命名正确
- [x] `.worktreeinclude` 声明的被 ignore 文件被复制进副本
- [x] 会话的读写与命令实际发生在 worktree 内（主工作区不受影响）
- [x] LRU 清理保留最近 15 个；运行中会话的 worktree 不被清理
- [x] 非 git 目录选 worktree 模式给出明确中文错误
- [x] 集成测试：同一仓库双会话（本地 + worktree）并行改动互不干扰
- [x] worktree 会话重启恢复后仍指向原 worktree

## Comments

### AC 逐条核对（2026-11-11，分支 `feature/09-managed-worktrees`，基线 8366efa，后合并 integration tip `2ccf7d2` 含工单 11/12/13）

1. **新会话可选模式；worktree 创建于约定目录、独立分支命名正确** ✅ 侧栏「+ 新建会话」选目录后弹 `NewSessionDialog` 选运行位置：「本目录直跑」（默认）/「worktree 模式」（说明文案含需 git 仓库与 `.worktreeinclude`）。worktree 模式在 `<CODEXLIKE_HOME>/worktrees/<会话id>` 检出（CODEXLIKE_HOME 隔离遵循 02 的 dataDir 解析），独立分支 `codexlike/<会话id>`——分支名 sanitize 直接复用 05 的 `codexlikeBranchName`（会话 id 为 UUID 天然合法，接口不假设）。agent-core 新模块 `worktree/worktree-service.ts`（`./node` 出口），创建即检出当前 HEAD。测试：约定目录/分支名/HEAD 内容/主仓库仍在 main（`+` 标记=被 worktree 检出）。
2. **`.worktreeinclude` 声明的被 ignore 文件被复制进副本** ✅ 项目根该文件每行一个路径（trim、跳过空行），创建时经 `resolveInWorkspace` 边界校验（防 `..`/链接逃逸，与工具层同一套）后复制进副本同位置；不存在的行跳过不报错（本机没有的 `.env` 等）；无该文件复制清单为空。测试：`.gitignore` 忽略 `.env` + `config/local.env` 两文件均复制、内容一致、不存在行跳过；E2E 用 fixture `.env` 断言复制进副本。
3. **会话的读写与命令实际发生在 worktree 内** ✅ 编排层（desktop `sessions/worktree-flow.ts` 的 `createSessionWithMode`）先检出副本再以**同一会话 id** 落库，`SessionRecord.workspacePath` 即副本路径——六件工具经执行上下文拿到的就是副本，读写与终端天然隔离。集成测试 `tests/worktree/parallel-sessions.test.ts`：local 会话文件落主仓库、worktree 会话文件落副本、互不覆盖、主仓库 `git status` 不含副本改动。
4. **LRU 清理保留最近 15 个；运行中不清理** ✅ `cleanup({ sessions, keep=15 })`：候选 = 孤儿（会话记录不存在，视作最旧优先删）∪ 已归档会话；按会话 `updatedAt` 倒序保留最近 15 个；`status !== 'idle'`（streaming/waiting-approval）**永不清理**（`skippedRunning` 返回）；活跃会话不在候选。删除走「解析 worktree 的 `.git` 文件得主仓库 → `git worktree remove --force` + `prune`」，元数据损坏退回直接删目录；**独立分支保留**（改动不丢，可人工找回）。触发点：archive IPC 后（后台执行不阻塞反馈）+ 应用启动时一次（main.ts）。测试：20 个归档候选删 5 留 15（s0–s4 删、s5–s19 留、分支仍在）、运行中 keep=0 也不删、活跃不删、孤儿优先、目录缺失安全。
5. **非 git 目录选 worktree 明确中文报错** ✅ `当前工作区不是 git 仓库，无法使用 worktree 模式：<路径>。请改用「本目录直跑」，或先在该目录执行 git init。`——**先检出后落库**的编排保证失败时无会话记录（单测断言 `manager.list()` 为空 + E2E 断言会话计数不变）；对话框保持打开，用户改选本目录直跑即可重试（E2E 实测恢复路径）。
6. **集成测试：同一仓库双会话并行互不干扰** ✅ 见 3；双会话用不同 profile id 分发模型工厂（共享 Map 边 set 边发有时序竞态，第一版测试因此误绿→修正）。
7. **worktree 会话重启恢复后仍指向原 worktree** ✅ workspacePath 落库即天然成立；等价性测试锁定：含工具轮次的 worktree 会话同库重建 manager（等价重启）→ `record.workspacePath` 与恢复前逐字相等、`workspaceMode` 仍 worktree → 续跑 write_file 仍落副本、主仓库无痕迹。E2E 补真实重启：徽标恢复 + 续跑文件仍在副本。

### 关键实现事实（后续工单建立在这些接口上）

- **agent-core 出口**：`./node` 新增 `createWorktreeService({ worktreesDir })`（`createForSession` / `cleanup`）与常量 `WORKTREE_INCLUDE_FILE` / `WORKTREE_KEEP_DEFAULT`；类型 `ManagedWorktree` / `WorktreeService` / `WorktreeCleanupSession` / `WorktreeCleanupResult`。主出口新增类型 `WorkspaceMode`（'local' | 'worktree'，UI 徽标与对话框用）。
- **持久化**：sessions 表新增 `workspace_mode`（新库 DEFAULT 'local'，旧库 ALTER 幂等迁移，非法值恢复 local）；`SessionRecord.workspaceMode` 必填——**手写记录的测试工厂都要补**（approvalMode 同款坑，本次波及 8 个文件）。`manager.create` 新增可选 `workspaceMode` 与 `id` 注入（宿主先建 worktree 再以同 id 落库，目录名=会话 id）。
- **编排层在 desktop**（agent-core 的 manager 保持同步）：`sessions/worktree-flow.ts` `createSessionWithMode({ manager, worktreeService, workspacePath, workspaceMode })`，可脱离 Electron IPC 单测；IPC `sessions:create` 第二参数 `workspaceMode`（枚举校验）。
- **UI**：`NewSessionDialog`（data-testid：`new-session-dialog` / `mode-local` / `mode-worktree` / `create-session-confirm` / `create-session-cancel`）；会话卡片 `worktree-badge` 徽标（violet，悬停显示副本路径）。**新建会话多了一步对话框确认**——所有点 `new-session` 的 E2E 都要跟一句 `create-session-confirm` 点击。
- **`/new` 命令**保持本目录直跑当前工作区（不经对话框；worktree 会话里 `/new` 以当前目录=副本直跑，语义合理）。

### 设计决策与偏离说明

- **删除只删 worktree 目录、不删分支**：规格只说「清理 worktree」；分支保留让误归档/误清理的改动可人工找回（`git branch -D` 不可逆），磁盘大头（工作区文件）已释放。Comments 记录于此，如需连分支清理是后续小改动。
- **孤儿 worktree 也进候选**：会话记录已不存在的副本无人认领，作为最旧候选优先清理（会话「删除」路径当前 UI 未提供，孤儿主要来自异常残留；启动时清理兜底）。
- **取消归档不重建副本**：worktree 已被 LRU 清理后恢复归档会话，workspacePath 指向已删目录（agent 写文件会重建目录吗——write_file 的 mkdirSync recursive 会兜底，但 git 语义丢失）。工单未要求处理，接受该语义。
- **worktree 模式下改动面板**（05 的 git status/diff/commit）天然工作在副本内：`createGitService(record.workspacePath)` 的 workspacePath 即副本，无需改动。

### 踩坑记录（对后续工单有用）

- **「模型」label 现在有三个**：设置页 Profile 表单输入 + 工单 13 的子代理模型 select（aria-label 同名）+ 输入区模型选择器；E2E 填 Profile 时必须 `window.locator('form').getByLabel('模型')` 限定（同「两个保存按钮」问题模式，05/06 已记，本次再+1）。
- **新建会话对话框对并行工单 E2E 的破坏**：11/12/13 基于无 09 的基线开发，其 E2E 点完 `new-session` 直接等 `session-item` 会超时——合并方须给**全部** E2E 补 `create-session-confirm` 步骤（本次 mcp/subagents 两脚本是合并后跑挂了才发现，先跑一遍全部 E2E 再说全绿）。
- **并行会话测试的模型工厂竞态**：`languageModelFor` 按 profile 对象分发，两个会话共享同一 profile 时「先注册工厂再发送」的顺序依赖会被 Promise.all 打乱（local 会话实际拿到 worktree 的模型）；双会话用不同 profile id（`profile-local` / `profile-worktree`）各自注册工厂即可消除时序。
- **git branch --list 的前缀标记**：被 worktree 检出的分支显示 `+`（非 `*`/空格）；测试断言先 `.trim()` 再比分支名，别比前缀。
- **Windows SQLite 句柄锁临时目录**（02 已记，本工单再犯）：manager 测试里创建的 store 不 close，afterAll `rmSync` EPERM 且**测试本体全绿、只有清理失败**——收集句柄统一 close 再删目录。
- **20 个 worktree 的 fixture 测试要显式加超时**：`git worktree add` 在 Windows 每个约几百 ms，vitest 默认 5s 会超时（`{ timeout: 120_000 }`）。

### 测试与验证

- `pnpm typecheck` 三包 0 错误；`pnpm test` 合并后 **360 用例全绿**（agent-core 260 + desktop 50 + ui 50，含 11/12/13 全部用例）。本工单新增：worktree-service 10 + parallel-sessions 2 + sqlite-store 2 + manager 1 + desktop worktree-flow 3 = **18 用例**。
- E2E **九条全过**：六条既有（smoke / commands / compact / changes / approvals / interrupt，均补对话框确认步骤）+ 本工单新增 `test:e2e:worktree`（git repo + `.worktreeinclude` fixture → worktree 模式全链路：徽标/副本/分支/复制 → write_file 落副本 → 真实重启恢复续跑 → 非 git 中文报错不落库 → 改选直跑可恢复）+ 并行工单的 mcp / subagents（合并适配后回归）。
- 顺手项：WorkspacePage.tsx 的 `current`/`currentSession` 等价变量已统一为 `current`（05 遗留）。
