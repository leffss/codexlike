---
status: accepted
---

# Provider Profile 多模型与任务级模型选择

一个 Provider Profile 原本恰好绑一个模型（`model` 单字符串），想同时用两个模型就得建两份 Profile、重复填同一套 baseURL 和 API Key。决定把 `model` 改为模型列表：一份接入配置挂 N 个模型名（纯手填，不做 `/v1/models` 拉取），任务的选择粒度升级为 `(providerProfileId, model)` 二元组——模型不再随 Profile 唯一确定，任务必须显式记录用了哪个。

## 关键边界

- 无「默认模型」概念：新建任务与模型记录失效的存量任务一律回退 Profile 列表第一项，表单首行以「默认」角标把这条规则显式化；不引入「Profile 换默认、未显式选择的任务跟随变化」的间接层。
- 子代理设置同步升级到模型级：可具体到某个模型，未配置时跟随主任务当前所用模型（原 `null` 语义从「同 Profile」细化为「同 Profile 同模型」）。
- 兼容走读时升级，无版本字段：`provider-profiles.json` 旧单 `model` 读取时包成单元素列表、下次保存自然写新格式；SQLite 存量任务无 model 记录，解析为列表第一项。与 profile-store 既有「损坏文件回退空列表」同款宽容逻辑。
- 重试不做 failover：多模型是并列配置不是故障转移弹药库，模型请求失败的重试仅把 Vercel AI SDK 内置 `maxRetries` 透出为全局执行设置（0–10，默认 2，覆盖对话/compact/子代理全部模型请求，ADR 0017 语义）；同 Profile 自动切模型明确拒绝，与 `/v1/models` 拉取、连通性测试同留后续增强。选择器呈现已由下文「呈现修订」更新，不影响重试边界。

## 取舍

拒绝「默认模型标记 + 任务可只存 Profile」：换默认时未显式选过模型的任务被静默改动，用户无此预期；二元组直白，且失效兜底（模型被删 → 回退第一项 +「已保存的模型不可用」提示）有现成语义可沿用。拒绝「每个 (Profile, 模型) 展开成虚拟 Profile 实体」：选择器保持单层但列表随组合数爆炸，增删模型即变 id，任务外键语义崩坏。拒绝 per-Profile/per-Task 的 maxRetries：重试是网络层韧性参数，与接哪家、哪个任务无关，全局一项足够。已知限制：thinking 参数仍无条件透传（ADR 0008），混模型 Profile 下非 GLM 模型 + thinking 开着可能报错，需手动关 thinking，不加 per-模型标记、不加自动降级。

## 呈现修订：模型与思考档位统一选择器

用户经交互原型选定 B 方案：任务输入区与新建任务共用一个「模型名 · 档位」入口，弹层顶部以提供商下拉浏览 Provider Profile，中部显示该 Profile 的模型，底部固定五档思考。提供商下拉仅筛选，不改发送偏好；点具体模型才保存二元组且保持弹层打开，点档位保存并关闭，外点或 Esc 不撤销已经保存的选择。收起时省去重复 Profile 名，完整身份通过弹层和提示保留。

本次只取代原平铺列表与分立档位控件的呈现。模型二元组、默认解析、失效提示、按工作台目标记忆及下一次请求生效的规则不变，也不添加模型能力检测。打开期间锁定按钮宽度、弹层尺寸与方向，切换内容不移动外框；较长列表在中部滚动，窗口或外部布局变化仍需重定位防裁切。

## 影响面

agent-core 的 ProviderProfile schema 与校验（`model` → 模型列表，非空、去重）、task 类型与 SQLite 持久化（+`model` 字段）；desktop 的 profile-store 读时升级、IPC 契约（Profile CRUD shape 变化、任务创建/恢复携带 model）、子代理设置存储（`providerProfileId` 之外 +model，null 跟随主任务当前模型）；ui 的 Profile 表单（动态行列表：增删/上下移/首行默认角标）、模型选择器（平铺「Profile 名 · 模型名」）、设置页执行分区新增重试次数一项；GLOSSARY 的 Provider Profile / 执行设置 / 子代理词条同步更新。
