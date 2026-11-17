# Spec: Provider Profile 多模型 + 模型请求重试可配

Status: ready-for-agent

决策依据：ADR 0024（`docs/adr/0024-provider-profile-multi-model.md`）；探索事实见同目录 `notes.md`。

## Problem Statement

想同时用同一家接入下的两个模型（比如一个强模型做主任务、一个快模型跑 compact），必须建两份 Provider Profile、重复填同一套 baseURL 和 API Key；改 API Key 要改两处，模型选择器里两份配置也无法体现「这是同一家接入」。同时模型请求失败后的重试次数写死为 SDK 默认（2 次），网络不稳时太脆、调试时又嫌它慢，用户无处可调。

## Solution

一份 Provider Profile 挂多个模型名（纯手填），任务在「Profile · 模型」粒度上选择并记住所用模型，子代理设置同样可选到具体模型。模型请求重试次数成为设置页「执行」分区的可调项（0–10，默认 2），作用于全部模型请求。旧配置与历史任务无感升级。

## User Stories

配置侧：

1. As a 用户, I want 在一份 Provider Profile 里添加多个模型名, so that 同一家接入下能在多个模型间切换而不用重复填 baseURL 和 API Key。
2. As a 用户, I want 在 Profile 表单里逐行增删模型名（每行一个），so that 模型清单的维护直观可见。
3. As a 用户, I want 上下移动模型行调整顺序, so that 最常用的模型排在最前。
4. As a 用户, I want 看到第一行带「默认」角标, so that 明白新建任务会先用哪个模型。
5. As a 用户, I want 表单阻止空模型名与重复模型名, so that 不会存进坏配置。

选择侧：

6. As a 用户, I want 输入框旁的模型下拉平铺列出每个「Profile 名 · 模型名」选项, so that 一步选到具体模型。
7. As a 用户, I want 任务跨重启记住所选的具体模型, so that 恢复后续跑不用重选。
8. As a 用户, I want 所选模型已从 Profile 删除时得到「已保存的模型不可用」提示并回退到列表第一项, so that 任务不至于卡死。
9. As a 用户, I want 新建任务默认用 Profile 列表第一项模型, so that 不选模型也能直接开工。
10. As a 用户, I want `/model` 斜杠命令同样列出「Profile · 模型」选项, so that 键盘流也能选到具体模型。

子代理：

11. As a 用户, I want 在设置里为子代理指定到具体模型, so that 委派用便宜模型、主任务用强模型。
12. As a 用户, I want 子代理模型未配置时跟随主任务当前所用模型, so that 不配置也有合理行为。

重试：

13. As a 用户, I want 在设置页「执行」分区调整模型请求重试次数（0–10，默认 2）, so that 网络不稳时多忍几次、调试时设 0 快速失败。
14. As a 用户, I want 重试改动即时保存、只影响后续执行, so that 不用重启应用也不影响进行中的回合。
15. As a 用户, I want 该设置作用于对话、compact、子代理全部模型请求, so that 一处配置全局一致。
16. As a 用户, I want 重试耗尽后的失败提示清晰说明已重试次数, so that 知道失败前发生过什么。

兼容：

17. As a 老用户, I want 已有的单模型 Profile 升级后自动变成「一个模型的列表」, so that 无感过渡。
18. As a 老用户, I want 历史任务恢复时自动用其 Profile 列表第一项模型继续跑, so that 旧任务不因升级失效。

## Implementation Decisions

- **ProviderProfile schema**：`model` 单字符串改为模型列表；校验升级为：列表至少一项、逐项 trim 后非空、去重。GLOSSARY「Provider Profile」词条已更新。
- **任务模型选择粒度**：task 携带 `(providerProfileId, model)` 二元组，无「默认模型」概念；新建任务与模型记录失效场景一律回退 Profile 列表第一项，UI 沿用「已保存的模型不可用」提示语义。SQLite task 持久化增加 model 字段。
- **子代理全局设置**：升级到模型级——存 Profile + 具体模型，未配置时跟随主任务当前所用模型（原 null 语义从「同 Profile」细化为「同 Profile 同模型」）。
- **IPC 契约**：Provider Profile CRUD 的 shape（model → 模型列表）、任务创建/恢复携带 model、子代理设置 shape 相应扩展；preload 暴露面同步。
- **profile 存储**：`provider-profiles.json` 读时升级——旧单 `model` 读取时包成单元素列表，下次保存自然写新格式；无版本字段（与「损坏文件回退空列表」同款宽容逻辑）。apiKey 的 safeStorage 加密链路不变。
- **maxRetries 配置**：进设置页「执行」分区（ADR 0017 语义：即时保存、已开始执行用开始时的值），范围 0–10、默认 2（保持 SDK 现默认）；存储沿用 agent-settings JSON 与 resolver 注入范式（agent-core 经 options 收逐次解析的取值函数，不依赖存储实现）；对话 `streamText`、compact `generateText`、子代理请求全部消费该值；读取侧越界回退默认（不夹紧，ADR 0017 落地补记语义）。
- **失败提示**：`describeModelError` 的重试文案适配可配置值（含 maxRetries 为 0 时不再声称「已重试」）。
- **UI**：Profile 表单模型输入改为动态行列表（每行一个模型名，可增删、可上下移，首行「默认」角标）；模型选择器平铺「Profile 名 · 模型名」（保持现有 label 惯例与「未配置模型」「已保存的模型不可用」兜底态，维持窄宽度降级惯例）；设置页执行分区新增重试次数输入；`/model` 命令跟随选择器。
- **已知限制（本期不处理）**：thinking 参数仍无条件透传（ADR 0008），混模型 Profile 下非 GLM 模型 + thinking 开着可能报错，需手动关 thinking。

## Testing Decisions

只测外部行为（校验结果、解析出的模型、落盘格式、渲染输出、SDK 收到的参数），不测内部实现细节。全部沿用既有 seam，不新增：

1. **agent-core 公共接口**：`validateProviderProfile` 纯函数测列表校验语义；agent-task 经 `options.languageModelFor` 注入断言二元组解析、失效回退、maxRetries 到达 SDK 调用、子代理跟随语义。先例：provider 与 task 既有注入式测试。
2. **desktop profile-store**：临时目录注入，测读时升级、保存新格式、加密不变。先例：store 既有测试。
3. **SQLite 持久化 roundtrip**：task model 字段存取一致、存量任务无 model 回退。先例：persistence 既有测试。
4. **UI 组件测试**：表单动态行（增删/排序/角标/校验）、选择器平铺选项与兜底态、执行分区重试项（含越界回退）。先例：ui 既有组件测试布局。
5. **e2e**：settings、模型选择器、执行设置相关既有场景按新交互面更新；合入前实跑相关场景（repo 纪律）。

## Out of Scope

- 多模型 failover（失败自动切同 Profile 下一个模型）——后续增强工单
- `/v1/models` 端点拉取模型列表——后续增强工单
- Profile 连通性测试（「测试连接」按钮）——后续增强工单
- 模型选择器两级分组 UI——后续优化
- per-模型 thinking 支持标记与失败自动降级
- per-Profile / per-Task 的重试配置
- 自管重试循环（错误分类、退避策略自研）

## Further Notes

- 决策记录：ADR 0024；GLOSSARY 三词条（Provider Profile / 执行设置 / 子代理）已随采访更新。
- 探索事实与符号定位：同目录 `notes.md`。
- 后续工单池（上面 Out of Scope 前四项）按需另开 `.scratch/` 票面。
