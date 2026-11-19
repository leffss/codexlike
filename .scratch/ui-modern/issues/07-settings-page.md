# 07: 设置页——七分区 + MCP 表单 + Provider Profile 表单

**What to build:** 设置页全套继承 D 语言：模型（Provider Profile 列表/表单/多模型行）、外观、启动与托盘、执行、终端执行、子代理、搜索源七个分区换暖色无边框语言；复杂表单（Provider Profile 多模型行、MCP server 表单/列表/启停）层级清晰、行操作可达性不降。

**Blocked by:** 01（token 基座）

**Status:** ready-for-agent

- [x] 七分区卡片化/分区标题/行间距按 D 语言统一
- [x] Provider Profile 表单（含 model-row 增删、默认模型徽章）层级清晰
- [x] MCP 分区（server 表单/列表/启停/重连/超时两项）样式统一、状态可辨
- [x] 开关/输入/下拉控件与工作台同语言；设置读写行为不变
- [x] ui 单测全绿（settings-page-ui / execution-settings-ui / mcp-settings-ui / provider-profile-form 等）
- [x] dev 双主题走查截图留证（设置页无专属 e2e，单测+走查为门槛）

## Comments

**2026-11-19 实施记录（票07）**

实施序列（TDD 三轮，每轮红→绿；新测试文件 `packages/ui/tests/settings-d-language.test.tsx` 19 例，期望值来自 notes.md/ADR 0028 定案）：

1. **轮 1 SettingsPage.tsx**：七分区卡（外观/托盘/执行/终端/子代理/搜索源）与 Profile 列表行去 `border-line` 换 `rounded-lg bg-surface-muted` 暖灰块；外层分区间距 gap-4→gap-6、表单卡内 gap-3→gap-4（留白呼吸）；编辑态 Profile 行去卡底（form 自带卡，避免灰上叠灰）；主题按钮未激活态去边框（激活仍 bg-accent 黑主张）；错误条/空状态去边框去虚线留软底；重试/清除等次级按钮去边框；Tavily 徽章改白卡中性（bg-surface + fg-muted）；checkbox 加 `accent-accent`（对齐 InteractionPanel 先例，黑主张/深色翻白）。
2. **轮 2 ProviderProfileForm.tsx**：表单卡暖灰块；Field/model-row 输入白卡（bg-surface）+ 聚焦 `focus:ring-[1.5px] focus:ring-fg/50` 深色细描边淡入（无边框纪律下的聚焦表达，深色 ring 即亮白）；校验错误态 border-danger-fg → `ring-1 ring-danger-fg`；默认模型徽章 bg-accent/15+text-accent → 白卡中性（bg-surface + fg-muted，accent 让位黑主张）；小钮统一 rounded-md；模型行组间距 gap-2→gap-3（走查反馈：多模型行分组感）。
3. **轮 3 McpSettingsSection.tsx**：server 列表行暖灰块；工具行/工具名改白卡（bg-surface）+ text-fg（不再借 accent）；工具启停 checkbox accent 化；错误行去边框；server 表单卡暖灰块、输入/textarea 白卡聚焦描边；超时表体同构；全部按钮圆角统一 6px（rounded-md）。

验证（直接取退出码）：

- ui 单测 581 全绿（exit 0，含新增 settings-d-language 19 例与既有 settings-page-ui/execution-settings-ui/mcp-settings-ui/provider-profile-form/settings-terminal-ui）；typecheck exit 0；build exit 0。
- 产物 CSS 核验：`accent-accent`→`accent-color:var(--accent)`、`focus:ring-[1.5px]`→`calc(1.5px + …)`、`ring-fg/50`→color-mix 生成（jsdom 只断 className，产物核验补齐样式真生成）。
- dev 双主题走查（vite 5181，IAB 实测）：浅色 4 张 + 深色 4 张存 `.scratch/ui-modern/screenshots/07/`（light: models-theme/provider-form/mcp-form/execution-terminal；dark: models-theme/provider-form/subagent-mcp/mcp-form）。目检结论：浅色暖白+暖灰块+黑主钮+白输入卡成立；深色暖深灰层次（次级面亮一档、输入暗一档、亮白主张按钮）可辨；Provider 多模型行（默认徽章/上移下移删除/禁用态）与 MCP 表单双主题层级清晰。
- 行为不动：设置读写/校验/重试路径零改动（纯 className），testid/交互/七分区信息结构均未动。

给票 08（收尾）的衔接注意：

- 设置页输入控件语言已定：`bg-surface` 白卡 + `focus:ring-[1.5px] focus:ring-fg/50` 聚焦描边、错误态 `ring-1 ring-danger-fg`——票 03/06 若另有输入聚焦表达，请对齐此写法（勿用 border 聚焦）。
- 行操作小钮（编辑/删除/重连/上移/下移）保持裸文字 + hover 底色（fg-muted 档），深色下可读性可用但偏紧——若票 08 全局走查觉得弱，可统一提一档（属全局 token/类决策，勿单改本页）。
