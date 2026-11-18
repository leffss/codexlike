# 模型与思考档位统一选择器（正式实现）

状态：用户确认修订 B 原型，已批准正式实现计划。基点 a7f9311。原型保留于相邻 model-thinking-select worktree / prototype/model-thinking-select（未提交），不进入生产。

## 用户确认的行为

- 现有任务 MessageComposer 与新建任务 NewTaskStart 共用一个选择器，分别保留底栏与输入卡上方位置。
- 收起显示「模型名 · 档位」，长模型名截断而档位不消失；title 保留 Profile 和完整模型。
- 一个 dialog：顶部原生 Provider Profile 下拉；中部仅该 Profile 模型列表；底部固定五档 auto/low/medium/high/off。
- 提供商下拉仅浏览筛选，不改变偏好；点模型才即时保存二元组且保持打开，思考档位不变。
- 点档位即时保存并关闭；Esc/外点只关闭，不撤销；无需确认。
- 重开定位到已选模型所属 Profile；原生下拉和组合弹层键盘行为不能冲突。
- 不改变默认、持久化、按工作台目标隔离、运行中只影响下次发送、请求快照或设置页。
- 无配置/失效选择可识别，不静默替换 Profile 或模型；整体只读与 thinkingEffort=null分别处理。
- 打开期间按钮宽度、弹层尺寸/位置/方向稳定，不因模型名或列表长度变动跳动；模型区滚动，头尾固定；窗口/布局/外部滚动时重定位防裁切；关闭/卸载恢复宽度并清理。

## 组件与 E2E 契约

组件 ModelThinkingSelect 的 props：profiles（readonly）、selectedProfileId（string）、selectedModel（string|null|undefined）、thinkingEffort（ThinkingEffort|null）、disabled?、onSelectModel(profileId,model)、onSelectThinkingEffort(effort)、className?。

- trigger：data-testid=model-thinking-select；data-model-value 为现有 modelOptionValue 复合值；data-thinking-effort 为当前档位；aria-haspopup=dialog、aria-controls 与实际 dialog 关联。
- dialog：data-testid=model-thinking-popover，role=dialog，aria-label=模型与思考。
- 提供商原生 select：data-testid=model-thinking-provider。
- 模型容器：data-testid=model-thinking-models，role=group，aria-label=模型。
- 可选模型 button：data-testid=model-thinking-model-option-${value}、data-value=${value}、aria-pressed。
- 思考容器：data-testid=model-thinking-efforts，role=group，aria-label=思考档位。
- 思考 button：data-testid=model-thinking-effort-${effort}、data-effort、aria-pressed。
- 不保留隐藏旧 profile-select/thinking-effort-select。共享 E2E helper 可兼容其逻辑参数，把真实操作翻译成新 UI，并按旧helper返回约定用Escape结束模型操作。专用 E2E 必须直接验证模型选中不关闭。

## 预先约定测试接缝与流程

按 tdd 每行为 red→green：组件 props+真实DOM事件，父组件原回调，定位 hook DOM harness（mock几何不作为真实视觉证明），Electron E2E真实交互/请求快照。先定向测试，后完整单测/类型/lint/build，再串行相关E2E，最后Standards+Spec审查。

相关E2E：thinking / persistence / entries / exit / subagent-thinking / approvals / input-queue-composer；必要时 input-queue-items。使用build新产物，不能验证旧dist。根all不包含queue场景。

不提交/推送/合并，不修改主工作区既有改动，不修改原型以冒充正式实现。
