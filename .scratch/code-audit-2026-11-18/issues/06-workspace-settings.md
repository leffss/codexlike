# 06：工作台草稿、队列回包与设置反馈

Status: done
Integration: 最终全仓检查及队列编辑/持久化等真实E2E通过；详见../INTEGRATION.md
Blocked by: none

先读 ../spec.md、../notes.md；依据 ../REPORT.md F09/F21/F22/C01。用户已批准真实React+IPC边界测试seams。

## 所有权

ui/pages/{WorkspacePage,SettingsPage}.tsx、components/{ProviderProfileForm,McpSettingsSection}.tsx、lib/{workspace-state,persistent-workbench}.ts及对应tests。不得改MessageStream/Rail/task-view/live-task、core/desktop。

## 验收

- [x] F09离开编辑目标统一恢复原草稿且在flush之前，A→新建→A/A→B→A/卸载均可恢复；保留保存成功/失败原有语义。
- [x] F21initial保窗口且主动清空剔除旧contextWindowTokens，名称/API Key/model变更不丢设置。
- [x] F22执行/终端/子代理/MCP等初始错误可见可重试，读失败不得写默认值，重试成功恢复。
- [x] C01迟到success/error按taskId+页面代次校验，同任务旧sequence不覆盖新队列；保存只结束对应编辑实例。
- [x] 真实Workspace/Settings jsdom回归，失败/成功命令记录。

## Comments

- 已有jsdom/testing-library依赖，无需新依赖；模板provider-profile-form/new-task-start/subagent-rail-switch。
- F24默认由07保持富子代理数据不变IPC；如须Workspace接线，主代理会把接口写入本票Comments后你再接，不主动改07文件。
- tests exec vitest避免自动Core build；不提交，完成READY_FOR_BUILD。
- 主代理已扩展 input-queue-items.mjs：编辑“排队乙”→新建→回“首轮”，断言原草稿和编辑态；再编辑→设置→返回，同样断言原草稿。主代理持有e2e文件，不修改本票源码。
- 06 已生产冻结、READY_FOR_BUILD。未改 07 所有权文件、IPC、App/ApplicationExit；F24 无新增接线需求。全仓 build/test/E2E 仍由主代理执行，本实现者没有运行。
- F09 实际退出屏障也已覆盖：ApplicationExit 不卸载 Workspace，而是直接 flush；队列编辑现仅临时借用内存 composer，不覆盖持久原草稿。导航/卸载统一同步恢复；保存成功清空、失败及条目失效保留输入，保存期间新输入也转为持久草稿。

## 实现与验证记录（2026-11-18）

### 测试接缝

真实 WorkspacePage / SettingsPage / ProviderProfileForm / ApplicationExit + React jsdom/testing-library；只替换 window.codexlike IPC 与 jsdom 缺失的 ResizeObserver/scrollIntoView。工作现场用内存 IPC 存储，并重新 createWorkspaceState + loadTask 验证恢复，不读取任何真实用户数据。无新依赖。

### Red → Green

下列命令前缀统一为 `pnpm --dir C:/Users/leffss/Desktop/ai-agent --filter @codexlike/ui exec vitest run`；每条 Red 均在对应最小修复前实际执行，退出码 1；随后相同用例或累计文件重跑退出码 0。`-t` 未匹配项为过滤跳过，不计为执行。

| 范围                  | Red 命令后缀                                                   | 实际失败证据                                                | 修复后结果           |
| --------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- | -------------------- |
| F09 新建绕行          | `tests/workspace-queue-ui.test.tsx`（当时仅1项）               | 新建入口读取时原草稿已被 `A-1 排队文字` 覆盖                | 1/1 绿               |
| F09 卸载              | `tests/workspace-queue-ui.test.tsx -t 'F09 卸载'`              | 重建工作台恢复出未保存的队列修改而非原草稿                  | 1/1 绿               |
| F09 同任务重选/切任务 | `tests/workspace-queue-ui.test.tsx -t 'F09 重新选择'`          | 同任务重选1红，A→B→A对照1绿                                 | 2/2 绿               |
| F09 真正退出          | `tests/workspace-queue-ui.test.tsx -t 'F09 真正退出'`          | ApplicationExit 回报 flushed 后恢复出队列文字               | 1/1 绿               |
| F09 保存结算          | `tests/workspace-queue-ui.test.tsx -t 'F09 保存结算'`          | 失败输入只留内存，重开丢失；成功对照绿                      | 2/2 绿               |
| F09 条目失效          | `tests/workspace-queue-ui.test.tsx -t 'F09 编辑目标'`          | remove/sending 后保留输入未落入工作现场                     | 2/2 绿               |
| F21 保值              | `tests/settings-page-ui.test.tsx -t 'F21 仅改'`                | 名称/API Key/模型三项 initial 窗口均为空                    | 3/3 绿               |
| F21 主动清空          | `tests/settings-page-ui.test.tsx -t 'F21 主动清空'`            | 清空后 update payload 仍含旧 `contextWindowTokens: 64000`   | 1/1 绿               |
| F22 执行              | `tests/settings-page-ui.test.tsx -t 'F22 执行'`                | 初读错误被 loaded 门控隐藏                                  | 1/1 绿               |
| F22 终端              | `tests/settings-page-ui.test.tsx -t 'F22 终端'`                | 初读错误不可见                                              | 1/1 绿               |
| F22 子代理            | `tests/settings-page-ui.test.tsx -t 'F22 子代理'`              | 初读错误不可见                                              | 1/1 绿               |
| F22 MCP超时           | `tests/settings-page-ui.test.tsx -t 'F22 MCP 超时'`            | 初读错误不可见                                              | 1/1 绿               |
| F22 搜索源            | `tests/settings-page-ui.test.tsx -t 'F22 搜索源'`              | 初读错误被 configured 门控隐藏                              | 1/1 绿               |
| F22 MCP列表           | `tests/settings-page-ui.test.tsx -t 'F22 MCP 列表'`            | 初读失败仍可添加配置且无重试                                | 1/1 绿               |
| F22 模型列表          | `tests/settings-page-ui.test.tsx -t 'F22 模型列表'`            | 失败被当作空列表，新建未禁用                                | 1/1 绿               |
| F22 托盘              | `tests/settings-page-ui.test.tsx -t 'F22 托盘'`                | 无错误提示/重试并出现 unhandled rejection                   | 1/1 绿，无未处理异常 |
| C01 导航              | `tests/workspace-queue-ui.test.tsx -t 'C01 导航'`              | A→B与A→B→A，success 清掉新页面队列、error 污染消息流，共4红 | 4/4 绿               |
| C01 sequence          | `tests/workspace-queue-ui.test.tsx -t 'C01 同任务'`            | event/operation 两种新快照均被旧回包覆盖                    | 2/2 绿               |
| C01 编辑实例          | `tests/workspace-queue-ui.test.tsx -t 'C01 保存'`（当时仅2项） | 取消重开同taskId/itemId/文字的新编辑被旧success/error结束   | 2/2 绿               |
| C01 保存回包          | `tests/workspace-queue-ui.test.tsx -t 'C01 保存回包'`          | 回到同任务或新事件到达后，旧保存回包覆盖队列                | 2/2 绿               |
| C01 保存中新输入      | `tests/workspace-queue-ui.test.tsx -t 'C01 保存期间'`          | 新输入显示仍在但重建状态丢失                                | 1/1 绿               |

C01 采用页面 taskId + taskRequest 代次守卫，队列单独 sequence 水位，不抬高消息事件水位（避免吞掉正文事件）；编辑实例以同步 ref 对象身份校验。

### 最终已执行检查

在主代理通知 Core 已统一 build 后执行，均直接取退出码，无管道。

```bash
pnpm --dir C:/Users/leffss/Desktop/ai-agent --filter @codexlike/ui exec vitest run tests/workspace-queue-ui.test.tsx tests/workspace-state.test.ts tests/settings-page-ui.test.tsx tests/provider-profile-form.test.tsx tests/execution-settings-ui.test.tsx tests/settings-terminal-ui.test.tsx tests/mcp-settings-ui.test.tsx tests/queue-bar-ui.test.tsx tests/composer-buttons-ui.test.tsx tests/new-task-start-ui.test.tsx
# exit 0；10 文件 / 107 测试通过；新增真实页面32项（Workspace20 + Settings12）

pnpm --dir C:/Users/leffss/Desktop/ai-agent --filter @codexlike/ui exec tsc --noEmit -p tsconfig.json
# exit 0；已修正新测试 ByRoleOptions 不支持 exact 的类型问题

pnpm --dir C:/Users/leffss/Desktop/ai-agent exec eslint C:/Users/leffss/Desktop/ai-agent/packages/ui/src/pages/WorkspacePage.tsx C:/Users/leffss/Desktop/ai-agent/packages/ui/src/pages/SettingsPage.tsx C:/Users/leffss/Desktop/ai-agent/packages/ui/src/components/ProviderProfileForm.tsx C:/Users/leffss/Desktop/ai-agent/packages/ui/src/components/McpSettingsSection.tsx C:/Users/leffss/Desktop/ai-agent/packages/ui/src/lib/workspace-state.ts
# exit 0；本票源码无错误/警告

git -C C:/Users/leffss/Desktop/ai-agent diff --check -- packages/ui/src/pages/WorkspacePage.tsx packages/ui/src/pages/SettingsPage.tsx packages/ui/src/components/ProviderProfileForm.tsx packages/ui/src/components/McpSettingsSection.tsx packages/ui/src/lib/workspace-state.ts
# exit 0
```

本票文件已显式路径 prettier 格式化。全仓检查、真实 Electron E2E、最终独立复审为主代理后续项，不冒称已执行。

### 本票修改文件清单

- `C:/Users/leffss/Desktop/ai-agent/packages/ui/src/pages/WorkspacePage.tsx`
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/src/pages/SettingsPage.tsx`
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/src/components/ProviderProfileForm.tsx`
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/src/components/McpSettingsSection.tsx`
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/src/lib/workspace-state.ts`
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/tests/workspace-queue-ui.test.tsx`（新增，真实工作台回归）
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/tests/settings-page-ui.test.tsx`（新增，真实设置页回归）
- `C:/Users/leffss/Desktop/ai-agent/.scratch/code-audit-2026-11-18/issues/06-workspace-settings.md`（本票状态、核销、红绿记录）
