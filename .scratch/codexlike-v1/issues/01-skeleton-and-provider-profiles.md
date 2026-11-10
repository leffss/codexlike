# 01: 项目骨架 + Provider Profile 设置

**What to build:** 从零建立 pnpm monorepo（`agent-core` 纯 TS 包、`desktop` Electron 主进程包、`ui` React 渲染包），`pnpm dev` 一条命令启动 Electron 应用：中文界面、空三栏布局（会话列表/消息流/输入框）与设置页。设置页可创建/编辑/删除多个 Provider Profile（名称、`baseURL`、`apiKey`、`model`），`apiKey` 经 Electron `safeStorage` 加密后落盘（磁盘上无明文），重启应用配置完整恢复。`agent-core` 提供 Provider Profile 类型与 OpenAI 兼容 provider 构造（Vercel AI SDK），有基于 `MockLanguageModel` 的单测。tsc strict + vitest 构成 CI 检查。

遵循 `GLOSSARY.md` 术语与 `docs/adr/0001`、`docs/adr/0002`。完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `pnpm install && pnpm dev` 启动应用，显示中文三栏布局与设置页
- [ ] 设置页可增删改查多个 Provider Profile，表单校验（URL 合法、model 非空）
- [ ] `apiKey` 加密落盘：数据文件中检索不到明文 key
- [ ] 重启应用后全部 Profile 完整恢复
- [ ] `agent-core` 的 provider 构造单测通过（OpenAI 兼容 `baseURL` 透传）
- [ ] tsc strict 与 vitest 全绿；`agent-core` 无任何 Electron 依赖（ADR-0002）
