# 02: 会话循环 + 流式消息 UI

**What to build:** 用户点「新会话」选择工作区目录，在输入框发消息，模型经所选 Provider Profile 流式回复，消息流实时增量渲染 markdown；会话与消息写入 SQLite（`~/.codexlike/`），侧栏会话列表显示全部会话，重启后列表仍在；输入区带模型（Provider Profile）选择器。`agent-core` 的会话对象（创建、发消息、流式事件、完成/出错状态）不依赖 Electron，主进程经类型化 IPC 把事件流桥接到渲染进程。含一条 Playwright `_electron` E2E 冒烟：启动 → 建会话 → 消息往返。

遵循 `GLOSSARY.md`；完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** 01 (项目骨架 + Provider Profile 设置)

**Status:** ready-for-agent

- [ ] 新建会话可选择工作区目录（原生目录选择器）
- [ ] 发送消息后 token 增量流式渲染为 markdown（含代码块高亮）
- [ ] 会话、消息落 SQLite；重启应用侧栏显示既有会话列表
- [ ] 模型选择器切换 Provider Profile，对下一条消息生效
- [ ] 模型 API 出错时消息流显示中文错误提示，会话可继续使用
- [ ] `agent-core` 测试（`MockLanguageModel`）：单轮问答、多轮上下文保持、流式中断与错误路径
- [ ] E2E 冒烟通过（预置 Profile → 建会话 → 往返一轮）
