# 01: Provider Profile 多模型配置（端到端）

**What to build:** 用户能在 Provider Profile 表单里配置多个模型名（动态行：每行一个，可增删、可上下移排序，首行带「默认」角标），同一份接入配置（baseURL + apiKey）挂 N 个模型；旧的磁盘单模型配置无感升级为单元素列表。在任务级模型选择落地（票 02）之前，现有任务链路解析为 Profile 列表第一项模型，行为不破。校验：模型列表至少一项、逐项 trim 后非空、去重。决策依据 ADR 0024；符号定位见 `../notes.md`；用户故事见 `../spec.md` 1–5、17。

**Blocked by:** None（可立即开始）

**Status:** ready-for-agent

- [ ] 表单模型区为动态行列表：可增删、可上下移排序、首行「默认」角标可见
- [ ] 空模型名、重复模型名被校验拦截（提示与现有表单错误风格一致）
- [ ] 旧 `provider-profiles.json`（单 `model` 字段）加载后成单元素模型列表，下次保存写新格式；无版本字段；apiKey safeStorage 加密链路不变；损坏回退空列表行为不变
- [ ] 未显式选模型的任务解析为 Profile 列表第一项，现有对话链路行为不破
- [ ] agent-core（校验/工厂兼容）与 desktop（store 读时升级）单测新增且通过，ui 表单组件测试新增且通过，三包基线不红
- [ ] e2e settings 相关场景按新表单交互面更新并实跑通过
