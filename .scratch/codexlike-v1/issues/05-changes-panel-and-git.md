# 05: 改动面板 + git 集成

**What to build:** 消息流区可唤起侧滑改动面板：列出工作区 `git status` 的变更文件（新增/修改/删除标识），点文件用 Monaco diff 视图查看改动；提供「一键创建分支（`codexlike/<会话名>`）」与「一键 commit」——commit 消息由模型按会话内容生成、可编辑，提交当前全部变更。非 git 工作区时面板明确降级提示。git 操作经 `simple-git` 封装在 `agent-core` 的 git 服务中，可脱离 Electron 测试。

遵循 `GLOSSARY.md`；完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** 03 (六件核心工具 + 工具卡片)

**Status:** done

- [x] 改动面板列出 `git status` 变更文件并正确标识类型
- [x] Monaco diff 查看单文件改动（新旧两侧对比）
- [x] 一键创建分支 `codexlike/<会话名>`，成功有反馈
- [x] 一键 commit：模型生成消息（可编辑）→ 提交 → 面板刷新
- [x] 非 git 目录显示「非 git 工作区」提示，不报错崩溃
- [x] git 服务测试（临时 git repo fixture）：status/diff/branch/commit 全路径

## Comments

### AC 逐条核对（2026-11-11，分支 `feature/05-changes-panel-and-git`，基线 26e6d5c，后合并 integration tip 18bc4e9）

1. **改动面板列出 `git status` 变更文件并正确标识类型** ✅ `ChangesPanel`（ui）经 IPC `git:status` 列出变更文件，新增/修改/删除/重命名四种彩色徽标（staged A 与 untracked 均显示「新增」，`rm --cached` 的 D+?? 双记录去重取首条）。工作区为 repo 子目录时只列子目录内变更、路径相对工作区（`revparse --show-toplevel` 前缀过滤）。E2E 断言「新增」徽标 + 当前分支 main。
2. **Monaco diff 查看单文件改动（新旧两侧对比）** ✅ `MonacoDiff` 组件（`@monaco-editor/react` + `monaco-editor` 本地打包，`loader.config({ monaco })` 不走 CDN，editor worker 显式提供）；`diffFile` 返回 HEAD 版本与工作区版本全文（新文件原侧空、删除新侧空、重命名按 oldPath 命中 HEAD），CRLF 统一 LF 防全行假差异。Monaco 独立 chunk（4MB）懒加载，主 bundle 仅 +9KB。E2E 断言 `.editor.original/.modified` 两侧渲染。
3. **一键创建分支 `codexlike/<会话名>`** ✅ 按钮文案预览完整分支名（`codexlikeBranchName(sessionTitle)`：非法字符→`-`、截 48 字符、空回退 `session`）；`checkout -b` 创建并切换，分支已存在则切换过去（幂等，created=false 也有反馈）；成功后面板徽标切到新分支。E2E 实测 `codexlike/workspace` 反馈 + 徽标切换。
4. **一键 commit：模型生成消息（可编辑）→ 提交 → 面板刷新** ✅ 「生成提交消息」走一次**不发工具**的 `generateText`（`buildCommitMessagePrompt`：最近 20 条消息×400 字符 + 变更文件列表，error 消息排除），消息填入可编辑 textarea（模型空白返回/未配 Profile 时中文提示并允许手写）；「提交全部变更」= `git add -A` + commit，成功显示哈希前 7 位并刷新列表；无变更时 `committed=false` 中文原因不报错。E2E 实测：mock 生成「添加 e2e-change.txt 示例文件」→ 人工修订 → 提交 → `git log`/`git status` 命令行侧验证落库、工作区干净。
5. **非 git 目录降级提示** ✅ `git:status` 对非 git 目录返回 `isGitRepo=false`（`checkIsRepo`，不抛错），面板显示「非 git 工作区」提示块；diff/分支/提交操作即使被调用也是中文错误。E2E 第二场景（plain 目录会话）实测提示出现、无报错。
6. **git 服务测试（临时 git repo fixture）** ✅ `tests/git/`：git-service 15 用例（干净仓库/非 git 降级/untracked+staged+删除标识/重命名 oldPath/子目录过滤/diff 新旧两侧/新删文件/路径越界拒绝/分支创建切换幂等/commit 落哈希/空变更/提交落会话分支）+ branch-name 5 用例 + commit-message 5 用例（MockLanguageModelV4 断言请求不带工具、prompt 含会话与文件），全部真实 `git init` fixture。

### 关键实现事实（后续工单建立在这些接口上）

- **agent-core 出口**：`./node` 新增 `createGitService(workspacePath)`（status/diffFile/createSessionBranch/commitAll）与 `generateCommitMessage({ model, messages, changedFiles })`；主出口（浏览器安全）新增 git 域**类型**（`GitStatus`/`GitFileChange`/`GitFileDiff`/`GitBranchResult`/`GitCommitResult`）与纯函数 `codexlikeBranchName` / `buildCommitMessagePrompt`。**工单 09（托管 Worktree）直接复用 `createGitService`，勿另起 git 封装。**
- **IPC 新增** `IPC.git`：status / diff / createBranch / commitMessage / commit；preload 暴露 `window.codexlike.git.*`。分支名由主进程从 `session.title` 生成（渲染层不传名字）。
- **Monaco 集成范式**（后续如加代码编辑器沿用）：worker 导入路径是 `monaco-editor/editor/editor.worker?worker`（其 package.json `exports` 把 `./*` 映射到 `./esm/vs/*.js`，**不带** `esm/vs` 前缀）；`manualChunks: { monaco: ['monaco-editor'] }` + `React.lazy` 动态加载。
- **commit 消息生成**用当前选择的 Provider Profile（`generateCommitMessage` 的 model 参数注入），会话消息取 `manager.messages()`（含全部角色，error 在 prompt 组装时排除）。

### 踩坑记录（对后续工单有用）

- **simple-git 4.0.2 两处 API 缺陷需绕过**：(a) `status()` 在含 rename 记录时会**丢失后续条目**（-z 解析错位）——改用 `raw(['status','--porcelain=v1','-z','--untracked-files=all'])` 自行解析（~20 行，git 官方格式）；(b) `checkoutBranch(name)` 会把 start-point 拼成 `undefined`（报 `'undefined' is not a commit`）——改用 `raw(['checkout','-b',name])`。raw 路径都实测稳定。
- **fixture 时序**：`git add A` 后再 `git add B && git commit` 会把 A 一起提交走（commit 提交整个暂存区）——需要「staged 但未提交」的文件必须最后 stage。
- **porcelain 默认折叠 untracked 目录**（`?? dir/`）：status 加 `--untracked-files=all` 展开到文件级，否则面板出现目录条目。
- **E2E「保存」按钮选择器**：设置页现在有两个「保存」（Profile 表单 + 搜索源区，工单 10 引入），须 `.locator('form').getByRole(...)` 限定；分支徽标断言要等文本真正变化（`filter({ hasText: /^codexlike\// }).waitFor()`），元素存在即返回会读到 refresh 前的旧值。
- **merge 后 desktop 测试前必须重建 agent-core**（07 已记）：merge integration 后先 `pnpm build` 再 typecheck/test，否则报新导出 not found。

### 测试与验证

- `pnpm typecheck` 三包全过；`pnpm test`：merge 后 agent-core 194 + desktop 24 + ui 35 = **253 用例全绿**（含工单 08/10 合入的用例）。
- E2E 四条全过：`test:e2e:changes`（本工单新增，git 全链路 + 非 git 降级）、`test:e2e`（02/03/10 冒烟）、`test:e2e:commands`（07）、`test:e2e:compact`（08，merge 后回归）。
- merge `integration/codexlike-v1`（18bc4e9）冲突四处：package.json×2（两侧 e2e 脚本并存）、main.ts（两侧 import 并存）、WorkspacePage（改动面板布局 + compacting 并存），解后全绿。
