# 07: AGENTS.md 注入 + 斜杠命令 + @引用 + /status

**What to build:** 会话启动时自动发现并注入 AGENTS.md：全局 `~/.codexlike/AGENTS.md` + 项目根（git 根）→ cwd 逐层各取一个、按层拼接进系统提示，总量 32 KiB 截断。输入框获得斜杠命令与 `@文件引用` 解析层：输入 `/` 弹出命令菜单（`/new` 同工作区新会话、`/rename` 重命名、`/archive` 归档隐藏、`/model` 切换模型、`/status` 显示上下文 token 用量/模型/审批模式），输入 `@` 弹出工作区文件模糊搜索菜单，选中即把文件内容附加到该消息。解析层为纯函数，可脱离 UI 单测。

遵循 `GLOSSARY.md`；完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** 02 (会话循环 + 流式消息 UI)

**Status:** done

- [x] 全局 + 多层项目 AGENTS.md 按序拼接注入；超 32 KiB 截断
- [x] 五个斜杠命令全部可用且与等效 UI 操作一致
- [x] `/` 与 `@` 菜单：键盘可选、模糊匹配
- [x] `@引用` 的文件内容确实进入该条消息的模型上下文
- [x] 解析层纯函数单测：命令/引用/普通文本边界组合
- [x] AGENTS.md 发现测试：无文件、仅全局、多层叠加三种情形

## Comments

### AC 逐条核对（2026-11-11，分支 `feature/07-agents-md-slash-mentions`，基线 7f8c517）

1. **AGENTS.md 按序拼接注入 + 32 KiB 截断** ✅ `discoverAgentsInstructions`（agent-core `./node` 出口）：全局（`CODEXLIKE_HOME` 钩子 / `~/.codexlike`）→ git 根（`git rev-parse --show-toplevel`，无 git 退化工作区目录）→ cwd 逐层每目录取一个、按层拼接，总量按 UTF-8 字节 32 KiB 截断（不切半个字符，无 U+FFFD）。desktop `main.ts` 以 `systemPromptFor` 注入 manager，会话 create/restore 各计算一次 → `createAgentSession` 的 `system` 角色。测试：`tests/context/agents-md.test.ts`（三情形 + 跳层 + 无 git + 截断，7 用例）+ `tests/session/manager-commands.test.ts`（system 角色真实进入 doStream prompt）+ E2E 断言真实 HTTP 请求体同时含全局与项目标记。
2. **五个斜杠命令可用且与等效 UI 操作一致（同一 IPC 通道）** ✅ `/new`→`sessions:create`（同工作区，免目录选择器；「+ 新建会话」同通道）；`/rename`→`sessions:rename`（侧栏「重命名」行内编辑同通道）；`/archive`→`sessions:archive`（侧栏「归档」/「恢复」同通道，归档会话 `archivedAt` 落库、侧栏默认隐藏、可展开恢复）；`/model`→与模型选择器改同一 `selectedProfileId`（纯 ui 状态，发送时生效）；`/status`→`sessions:status`（模型 + token 估算 + 消息数 + AGENTS.md 来源数，`approvalMode` 预留 null 待工单 04）。E2E `e2e/commands.mjs` 逐一实测（含 /new 后侧栏 2 会话、/archive 后 1 会话 + 已归档区恢复）。
3. **`/` 与 `@` 菜单：键盘可选、模糊匹配** ✅ 解析层（agent-core 主出口，浏览器安全值导出）：`parseComposerDraft`（光标处草稿判定）+ `fuzzyMatch`（子序列、大小写不敏感、连续命中优先）；ui 纯函数 `computeMenu`/`handleMenuKey`（↑↓ 循环移动、Enter/Tab 选中、Esc 关闭，关闭后 draft 未变不重弹）。无参命令选中即执行（免二次 Enter），带参命令回填 `/{命令} ` 继续输入。单测 30 用例 + E2E 键盘流实测。
4. **@引用 内容进入该条消息的模型上下文** ✅ 发送解析提取 `mentionPaths` → 主进程 `readMentionAttachments` 读取（resolve+realpath 双重校验限工作区内，`..` 与符号链接逃逸拒绝并中文报错；单文件 128 KiB 截断）→ agent-core `sendMessage` 以 `<attached-file path>` 附加**该条** user 消息（多轮会话只附加所属消息，历史保持）；落库与消息流回显为用户原文。测试：`tests/session/session-context.test.ts` 断言 doStream prompt + E2E 断言真实请求体含文件内容。
5. **解析层纯函数单测：边界组合** ✅ `tests/composer/composer-parse.test.ts` 12 用例（空/空白、命令+参数任意空白、大小写不敏感、未知 `/etc/hosts` 按普通文本、非行首 `/` 非命令、多 @ 按序去重、`user@example.com` 不误伤、原文不改写）；`composer-draft.test.ts` 10 用例（光标在 token 内/中间/离开、中文标点终止、单行限制）；`fuzzy-match.test.ts` 8 用例。
6. **AGENTS.md 发现三情形测试** ✅ 无文件（sections 空、combined 空串、系统提示不注入——保持 02 行为）/ 仅全局 / 全局+多层叠加（顺序断言 全局→根→内层）均覆盖。

### 关键实现事实（后续工单建立在这些接口上）

- **agent-core 出口**：主出口新增 `resolveComposerSubmission` / `parseComposerDraft` / `extractMentionPaths` / `SLASH_COMMANDS` / `fuzzyMatch` / `estimateTokens`（全部浏览器安全，ui 值导入）；`./node` 新增 `discoverAgentsInstructions` / `composeSystemPrompt` / `AGENTS_MD_MAX_BYTES`。`SendMessageOptions.mentions?: MentionAttachment[]`、`CreateAgentSessionOptions.systemPrompt?: string`（空串不注入 system）。
- **token 估算稳定接口**：`estimateTokens(text)`——CJK/全角按 1.5 字符/token、其余 4 字符/token、向上取整。**工单 08 compact 直接复用，勿改规则。** /status 估算 = AGENTS.md combined + user/assistant 消息（error 不计）。
- **SessionRecord 新增 `archivedAt: string | null`**：sessions 表加 `archived_at` 列，`createSqliteSessionStore` 打开旧库时幂等迁移（ALTER TABLE + try/catch）。manager 新增 `rename` / `setArchived`（IPC `sessions:rename` / `sessions:archive`，archived=false 取消归档）。
- **@token 语法**：`@` 前须为行首或空白（邮箱不误伤），token 由非空白且非终止标点（中英文常用标点集合）构成；菜单候选来自 `sessions:workspace-files`（跳过 node_modules/.git/dist 等，上限 2000 条，POSIX 分隔符）。
- **IPC 新增**：`sessions:rename` / `sessions:archive` / `sessions:status`（`SessionStatusInfo` 含预留 `approvalMode: null`）/ `sessions:workspace-files`；`sessions:send` 第 4 参数 `mentionPaths?: string[]`。
- **E2E**：`e2e/commands.mjs`（`pnpm --filter @codexlike/desktop run test:e2e:commands`，先全仓 build）——mock server 记录请求体，断言 AGENTS.md 与 @引用内容真实进入模型请求。

### 设计决策与偏离说明

- **命令草稿限定单行**：多行文本不弹命令菜单（斜杠命令语义是「整条输入」）。
- **归档可恢复**：工单只说「归档不在侧栏显示」，但单向归档等于永久丢失；侧栏底部加「已归档（N）」折叠区（`sessions:archive` 传 false 恢复），成本一行 IPC。
- **顺手修正 02 边角**：恢复会话时 `error` 角色消息曾以 user 角色进入模型上下文（02 的 toModelMessage 对非 assistant 一律按 user）；现 agent-session 维护独立 `context: ModelMessage[]`，error 一律不入上下文（02 既有用例全部不受影响）。
- **@引用 读取放主进程**：路径校验（工作区内）与文件读取必须在不可信边界外做；渲染层只传相对路径，读取失败以中文异常经 IPC 抛回消息流。

### 踩坑记录（对后续工单有用）

- **desktop 的 vitest 走 agent-core 的 dist**：改 agent-core 源码后必须 `pnpm --filter @codexlike/agent-core run build`，否则 desktop 测试拿到旧产物报 `xxx is not a function`。
- **Windows 无开发者模式时 `symlinkSync` EPERM**：涉及符号链接的测试要探测降级跳过（mentions.test.ts 有样例），实现本身仍做 realpath 校验。
- **`node:sqlite` 新列迁移**：`CREATE TABLE IF NOT EXISTS` 不会给旧表加列，需显式 `ALTER TABLE ... ADD COLUMN` + try/catch 幂等；旧库测试先手工建旧 schema 再打开 store 验证。
- **Playwright `fill()` 触发一次 input 事件**：光标默认在末尾，菜单草稿判定可用；但键盘菜单流（Enter 选中）要用 `press`，且无参命令「选中即执行」的交互让 E2E 与真人操作都少一次按键。
- **JSON.stringify 断言 Windows 路径会被转义**（`C:\work` → `C:\\work`）：断言 prompt 内容时优先按结构断言（`prompt[0]` role/content）而非字符串化包含。

### 测试与验证

- `pnpm typecheck` 三包全过；`pnpm test`：agent-core 73 + desktop 17 + ui 23 = 113 用例全绿。
- `pnpm test:e2e`（02 冒烟）回归通过；`test:e2e:commands`（本工单新增）通过。
