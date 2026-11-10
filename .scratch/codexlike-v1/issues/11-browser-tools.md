# 11: Playwright 浏览器工具组

**What to build:** agent 获得五件浏览器工具：`browser_navigate`（打开 URL）、`browser_click`（选择器点击）、`browser_type`（输入框填写）、`browser_screenshot`（整页截图）、`browser_read`（提取正文文本）。基于 Playwright headless Chromium，首次使用时自动下载（有进度与失败提示）。`browser_read` 输出截断上限；截图保存为文件并在卡片展示，端点支持多模态时附给模型，否则降级为路径+说明。浏览器实例会话级复用（同一会话共享 Cookie/状态），会话结束关闭。

遵循 `GLOSSARY.md`；完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** 03 (六件核心工具 + 工具卡片)

**Status:** ready-for-agent

- [ ] 五件工具齐全，共享同一会话级浏览器实例
- [ ] 首次使用自动下载 Chromium，失败有中文提示与重试
- [ ] `browser_read` 返回提取正文（截断有标记）
- [ ] 截图卡片展示；多模态附图 / 降级两种路径都可工作
- [ ] 导航失败/超时返回明确错误，会话不崩
- [ ] 本地 HTML fixture 上的工具行为测试（navigate→type→click→read→screenshot 全链）
