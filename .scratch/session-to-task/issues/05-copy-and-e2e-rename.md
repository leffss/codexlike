# 05: 用户文案与 e2e 联动全量绿

术语依据换词后的 `GLOSSARY.md`；上游票 04 已就位（UI 结构已切新名，文案/testid 仍是旧值）。

**What to build:** 所有用户可见的「会话」文案换为「任务」，data-testid 值与 e2e 断言/场景表联动更名，全量 e2e 链跑绿——用户在界面上看到的最后一个「会话」字样消失。

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] UI 用户可见文案全换：侧栏（新建/暂无/置顶/aria 标签）、搜索弹层、右键菜单、工作台页（新建入口、未选择态等）、队列条、自动批准提示等
- [ ] agent-core 斜杠命令描述换词（`/new` `/rename` `/archive` `/status` 的中文说明）
- [ ] 20 个 session 系 data-testid 值换为 task 系；`check:e2e-locators` 联动通过
- [ ] 41 个 e2e 场景中依赖中文文案断言与 testid 的全部联动改；场景表（若登记）同步
- [ ] 全量 e2e 链按根 package.json 的全量链跑绿（直接退出码，不接管道）
- [ ] 全仓用户可见层面不再出现「会话」字样：grep 验证，代码注释、避免词列表与 ADR 除外
