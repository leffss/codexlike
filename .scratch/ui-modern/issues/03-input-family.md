# 03: 输入面家族——输入卡 / 新建任务起点 / 交互面板

**What to build:** 三个输入壳同形换 D 语言：正式任务输入卡、新建任务起点页（工作区卡+决策行+专属输入卡）、交互面板（执行审批三键 + 问答选项）统一为无边框 `#f7f6f3` 暖灰圆角块，聚焦深色细描边淡入；审批的批准/批量/拒绝保持绿/警示/红语义；问答单选/多选/自定义呈白卡选项 + inset 黑描边选中态；新建起点页居中布局观感与任务态连续。

**Blocked by:** 01（token 基座）

**Status:** ready-for-agent

- [ ] composer-card / new-task-composer / interaction-panel 三壳同形：暖灰块 + 聚焦描边淡入（白底上光晕不可见，用描边——原型已验证）
- [ ] 审批三键语义色可辨；批量批准警示文案区样式统一
- [ ] 问答选项白卡 + 选中 inset 黑描边；自定义回答输入同语言
- [ ] 新建任务起点页（new-task-start）整体继承：工作区卡、决策行、归属选择器
- [ ] 等待交互期间输入区禁用/替换行为、斜杠命令/@文件/技能菜单触发行为不变
- [ ] ui 单测全绿
- [ ] e2e 实跑绿：approvals / interactions / persistent-workbench / thinking / width-tiers（composer 几何断言）
- [ ] dev 双主题走查截图留证（含审批态与问答态——dev 预览 fixtures 三态可达）

## Comments
