# 编码标准

供 code-review 的 Standards 轴执行。

## E2E 定位器

E2E（`packages/desktop/e2e/*.mjs`）中的元素定位按用途收口（`pnpm check:e2e-locators` 拦截，pre-commit 运行）：

- **交互控件**（按钮/输入/链接，用于 click/fill/hover）：优先 `getByTestId('[data-testid]')`（组件已大量标注，如顶栏 `settings-open` / `settings-back`）；同页可能重复的控件（如设置页多个「保存」、含「模型」子串的多个 label），先 `locator('form')` / 容器限定再定位。**禁止根级裸 `getByRole('button', { name })`**——Playwright strict mode 下的多命中是本仓库已发生四次的回归来源。
- **内容断言**（消息正文/状态文本，用于 waitFor/断言，不用于交互）：允许根级 `getByText`，但必须显式处理多命中——`.first()` / `.nth()` / `{ exact: true }` / `.count()` 判定四者其一（多命中未处理会在 strict mode 直接报错暴露，加了其一则是显式选择）。
- **容器识别例外**：`locator('section').filter({ has: getByRole('heading', { name, exact: true }) })` 形式允许——heading 是文档语义结构（h2/h3 天然 aria 可达），exact 防子串，且 filter 参数不参与点击，不存在 strict mode 点错元素的风险。

链式限定（`form.getByRole` / `card.getByText`，定位挂在容器上）不受限；「根级」指直接挂在 `window` 根 locator 上。

豁免清单（见 `scripts/check-e2e-locators.mjs`）：`helpers.mjs` / `launch-target.mjs`（共享工具，无场景定位）；`projects-sidebar` / `interactions` / `exit-recovery` / `sidebar-archive`（flaky 治理分支收口，避免两分支碰撞）。新场景不得进豁免。

## 行为断言（真实输入路径）

交互能力的 e2e 验收断言**真实输入路径**，DOM 属性/类名断言只作辅助：窗口拖动这类走系统命中测试（Windows 返回 HTCAPTION）的能力，Playwright 合成鼠标事件只进渲染器输入管线、不经该路径，须以真实输入注入验证（user32 `SetCursorPos` + `mouse_event`，PowerShell P/Invoke，先例：`window-controls.mjs` 的 `nativeDrag`；注意 DPI 虚拟化与前景遮挡，见该文件注释）。审查者按「断言了机制还是行为」检查——2026-11-14 布局重构中拖动区断言只查类名，整左区 no-drag 的实现骗过全链 33 场景，由 Spec 轴人工审查才暴露。

## 数据目录自建

落盘到用户数据目录（`dataDir()` / 任务 workspace / 临时目录）的组件，打开或写文件前自己 `mkdirSync(dirname(path), { recursive: true })`，不假设调用方已建目录（先例：`json-file.ts`、`write-file.ts`、`apply-patch.ts`、`worktree-service.ts`）。

测试必须覆盖「父目录不存在」分支：E2E 以 `mkdtempSync` 预建 `CODEXLIKE_HOME` 的习惯会掩盖该分支——2026-11-11 打包黑屏事故中 `createSqliteSessionStore` 未建 `~/.codexlike`，11 条 E2E 全绿仍黑屏，靠 `test:e2e:packaged` 冷启动冒烟兜底。

## 会话初始态覆盖

E2E 场景默认从发送首条消息开始驱动（mock provider 便于造轮次），这个习惯会掩盖「首条消息之前」的生命周期分支：凡宣称会话内可用的 UI 能力（输入框菜单、侧栏面板、标题栏入口），至少一条断言覆盖初始态（draft 未发首条消息、任务恢复后未运行、发送失败后），再测运行态。先例：2026-11-15 修复 draft 态技能不可用（ADR 0007 补 draft 预览通道）时，skills.mjs 全部技能断言都在首条消息之后，该分支骗过全部场景，由用户实测暴露。审查者按「断言覆盖了初始态还是只覆盖运行态」检查。

## 测试名与断言同步

断言翻转或语义变更时，测试名同步改为描述当前行为——审查者按「测试名描述的是当前断言还是历史断言」检查（2026-11-16 subagent-records：spawn 行瘦身后断言已翻转为 `reasoning` undefined，测试名仍写「照旧拼接全文」，两轴 review 交叉点名）。

## vi.hoisted 不引用 import 绑定

`vi.mock` 工厂与 `vi.hoisted` 工厂都提升到 import 初始化之前执行，内部不得引用文件顶部 import 的任何绑定——`class FakeTray extends EventEmitter` 启动即 `ReferenceError: Cannot access '__vi_import_0__' before initialization`。hoisted 里的 fake 类自包含（手写迷你 emitter，只实现被测路径用到的方法；依赖重的改参数注入），import 绑定只在 hoisted 之外的模块代码里使用（2026-11-18 托盘轮 FakeTray 踩坑）。

## Windows spawn 坑（外部程序启动）

起真实外部程序（终端/编辑器/文件管理器）的功能，合入前真机手动验证一次启动路径——单测 mock 了 spawn 签名、e2e 测试钩子（`CODEXLIKE_TEST_OPENER_LOG` 类）不启动真实程序，spawn 的平台语义两者都替代不了（2026-11-18 终端打开器：`windowsHide: true` 把 bash/powershell/cmd 的控制台窗口整个藏掉，进程在跑但无窗口，37 单测 + e2e 实跑全过，由 Spec 轴 review 才暴露）。审查者按「起外部程序的改动是否真机验证过」检查。

平台语义两条判别：

- **detached 控制台程序靠弹自己的控制台窗口交互**：`windowsHide: true` 会把窗口藏掉；GUI 程序（wt/编辑器 exe）不受该 flag 影响——编辑器路径保持 hide 防闪窗，控制台程序显式 `windowsHide: false`（先例：`opener-launcher.ts` 终端分支）。
- **PATH 探测 exe 用已知安装位，不扫 PATH**：PATH 上的同名 exe 可能是替身——`System32\bash.exe` 是 WSL 启动器不是 Git Bash（cwd 继承后翻成 `/mnt/c/...`）；`WindowsApps` 下的应用执行别名是 reparse 点，`accessSync` 照常通过。自定义安装位置经显式配置项（`CODEXLIKE_GIT_BASH_PATH` 类）进候选（先例：`opener-resolver.ts` `probeShellExe`、agent-core `findGitBash`）。

## 拆分提交（partial-staged）

同一文件混两批改动、只提交其中一批时，lint-staged 在「恢复未暂存改动」一步失败并整体 revert——工具边界，不是格式问题。流程：对 staged 内容先跑 `prettier --check` 确认格式，再 `git commit --no-verify`；能整文件提交就拆开两批先后提交，避免 partial-staged（2026-11-11 项目侧栏拆分提交踩此坑）。
