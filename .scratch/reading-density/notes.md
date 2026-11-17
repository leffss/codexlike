# 正文排版密度（reading-density）

## 问题

任务正文与子代理正文排版过密、段落距离太近：

- **任务正文**（中栏四处共用 `.markdown`：助手气泡 / 过程段卡 / 压缩摘要 / 子代理报告）：
  `.markdown p { margin: 0.5em 0 }` 在 `text-sm`（14px）下塌缩后仅约 **7px** 视觉段距
- **子代理逐轮正文**（`SubagentRailPanel.tsx` 的 `SubagentRoundsDisclosure`）：
  纯文本 `text-xs`（12px）+ `mb-2`，是全部正文里最紧凑的一块

## 原型评审（2026-11-17）

四档原型页 `/prototype/reading-density`（中栏消息流 + 右栏子代理详情两处评审对象，
`?variant=` 切换），**完整原型留档在 `prototype/reading-density` 分支（6444714）**：

| 档       | 名称                 | 思路                                      |
| -------- | -------------------- | ----------------------------------------- |
| baseline | 现行排版             | 对照锚点                                  |
| **A**    | **舒适留白（选定）** | 结构不动，间距/行高整体放宽               |
| B        | 文档式               | 去气泡铺开 + 72ch 限宽 + 轮次 markdown 化 |
| C        | 块呼吸               | 组内紧组间松 + 标题分割线 + 轮次虚线      |

**结论：选 A**——落地成本最低（只改数值、不动结构），密度问题本质是间距数值
过小而非结构不对。

## 折入位置（A 档）

- `packages/ui/src/styles.css`：`.markdown` 全套规则放宽（段距 `0.85em`、行高
  `1.65`，标题 `1.3em 0 0.5em`、列表 `0.85em`、li `0.3em`+`1.6`、blockquote
  `0.9em`、pre `1em`+`1.6`、table `1em`、单元格 `0.45em 0.8em`、hr `1.2em`）
- `packages/ui/src/components/MessageStream.tsx`：助手气泡 `px-4 py-3` → `px-5 py-4`
- `packages/ui/src/components/SubagentRailPanel.tsx`（`SubagentRoundsDisclosure`）：
  轮次正文升 `text-sm leading-6`、轮距 `mb-2` → `mb-3`、轮标签固定 `text-xs`。
  思考与正文轮次同构组件，两处一起放宽（同为过程回看视角，密度一致）

## 验证

- ui 单测 447 全绿（退出码 0）；`check:e2e-locators` 通过（43 场景无根级裸定位，
  data-testid 均未动）
- 无头实测产线计算样式：`.markdown p` margin 11.9px / line-height 23.1px、
  气泡 padding 16px 20px，均生效
