# 06: 消息流工具卡 + 点击直跳详情

**What to build:** terminal 四工具的调用卡在消息流过程段的呈现（摘要显示会话名/状态/读取摘要，输出语义与现有工具卡一致），点击卡片直跳右栏「终端」tab 对应会话详情页——focus 机制照搬子代理标记行（点击 → setFocus → RailPanel 自动切 tab 并落到详情页）。文件指针见 notes.md §5。

**Blocked by:** 04, 05。

**Status:** ready-for-agent

- [ ] 四工具调用卡过程段正常渲染、完成态收起行为与过程段规则一致
- [ ] 点击直跳：自动切终端 tab + 落对应详情页；幂等守卫沿用现有 focus 模式
- [ ] 单测：卡片渲染 + focus 直跳（先例：子代理标记行 / message-rendering 系）
- [ ] ui test / typecheck 绿；涉及 e2e 交互面的实跑相关场景
