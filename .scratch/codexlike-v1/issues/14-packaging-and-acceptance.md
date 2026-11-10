# 14: 打包发行 + 验收走查

**What to build:** 用 electron-builder 产出 Windows NSIS 安装包与便携版 zip，本机全新安装可运行；应用图标与窗口标题为 CodexLike；README 写明构建、打包、Provider 配置与数据目录。最后逐条走查 spec 的 9 条验收场景（走查结果记录到本工单 comments），全部通过即 v1.0 完成。

9 条验收场景清单见 `.scratch/codexlike-v1/spec.md`「验收标准」节。

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13（全部前置工单）

**Status:** ready-for-agent

- [ ] electron-builder 产出 NSIS 安装包与便携 zip
- [ ] 全新安装（非开发机路径）启动、配置、会话全流程可用
- [ ] 应用图标与窗口标题 CodexLike
- [ ] README：构建/打包/配置/数据目录说明
- [ ] spec 9 条验收场景逐条走查通过并记录结果
