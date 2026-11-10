# 07: AGENTS.md 注入 + 斜杠命令 + @引用 + /status

**What to build:** 会话启动时自动发现并注入 AGENTS.md：全局 `~/.codexlike/AGENTS.md` + 项目根（git 根）→ cwd 逐层各取一个、按层拼接进系统提示，总量 32 KiB 截断。输入框获得斜杠命令与 `@文件引用` 解析层：输入 `/` 弹出命令菜单（`/new` 同工作区新会话、`/rename` 重命名、`/archive` 归档隐藏、`/model` 切换模型、`/status` 显示上下文 token 用量/模型/审批模式），输入 `@` 弹出工作区文件模糊搜索菜单，选中即把文件内容附加到该消息。解析层为纯函数，可脱离 UI 单测。

遵循 `GLOSSARY.md`；完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** 02 (会话循环 + 流式消息 UI)

**Status:** ready-for-agent

- [ ] 全局 + 多层项目 AGENTS.md 按序拼接注入；超 32 KiB 截断
- [ ] 五个斜杠命令全部可用且与等效 UI 操作一致
- [ ] `/` 与 `@` 菜单：键盘可选、模糊匹配
- [ ] `@引用` 的文件内容确实进入该条消息的模型上下文
- [ ] 解析层纯函数单测：命令/引用/普通文本边界组合
- [ ] AGENTS.md 发现测试：无文件、仅全局、多层叠加三种情形
