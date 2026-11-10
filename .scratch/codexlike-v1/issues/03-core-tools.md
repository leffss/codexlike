# 03: 六件核心工具 + 工具卡片

**What to build:** agent 获得工具注册表与六件内置工具——`read_file`（带行号）、`write_file`、`apply_patch`（补丁式编辑，上下文行必须精确匹配，失配拒绝并把原因返回模型）、`glob`、`grep`、`run_terminal_command`——并进入多轮自主循环：模型调工具 → 执行 → 结果回填 → 继续，直到给出最终回复。文件操作限制在工作区内（realpath 校验，`..` 与符号链接逃逸被拒）。`run_terminal_command` 默认经 Git Bash（`bash.exe -c`）执行、Windows↔POSIX 路径在工具层转换、可配置切换 PowerShell/cmd、环境变量白名单。所有工具带超时与输出截断。UI 中每次工具调用显示为可展开卡片（工具名、参数摘要、完整输出）。本工单内工具默认放行（审批三档在 04 引入）。

遵循 `GLOSSARY.md`；完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** 02 (会话循环 + 流式消息 UI)

**Status:** ready-for-agent

- [ ] 六件工具各自在真实临时目录上的行为测试通过
- [ ] `apply_patch` 上下文失配时拒绝并返回可读原因，模型可据此重试
- [ ] 工作区边界：逃逸路径（`..`、符号链接）被拒
- [ ] Windows 上 `ls`、`&&`、管道等 POSIX 命令经 Git Bash 正常执行
- [ ] 超长输出被截断（终端/文件/搜索各有上限），截断有标记
- [ ] 多轮工具循环测试（`MockLanguageModel` 脚本化：工具调用→结果→最终回复）
- [ ] UI 工具卡片渲染（含长输出折叠展开）
