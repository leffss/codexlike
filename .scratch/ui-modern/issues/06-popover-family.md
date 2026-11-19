# 06: 弹层家族——选择器 / 右键菜单 / 确认框 / toast / 退出冻结层

**What to build:** 全部弹层统一 D 语汇（白卡+发丝线+双层柔和小阴影+10px 圆角，阴影白名单成员）：模型与思考档位选择器、通用下拉、composer 补全菜单（/命令·@文件·$技能）、侧栏右键菜单、任务搜索浮层、完全访问确认对话框、任务归属/项目移除对话框、退出确认与进度冻结层、toast 通知（中性 hairline，类别语义色保留）。弹层定位/开合/键盘导航行为完全不变。

**Blocked by:** 01（token 基座）

**Status:** ready-for-agent

- [ ] model-thinking-popover 白卡化；portal 弹层从 html 继承 token（基座票已保证），几何锁定（use-stable-popover）行为不变
- [ ] 右键菜单/composer 菜单/任务搜索浮层白卡统一；选中/hover 态暖灰
- [ ] 确认对话框全家（full-access/membership/project-removal/exit-confirm/exit-progress）白卡 12px 圆角柔投影
- [ ] toast hairline 白卡、五类通知语义色保留可辨
- [ ] 弹层键盘导航（aria-activedescendant 等）行为不变
- [ ] ui 单测全绿
- [ ] e2e 实跑绿：thinking / membership / exit-recovery / task-search / approvals（full-access 对话框路径）
- [ ] dev 双主题走查截图留证

## Comments
