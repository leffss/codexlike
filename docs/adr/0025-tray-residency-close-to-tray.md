# 托盘驻留：关闭主窗口隐藏到托盘，退出唯一入口在托盘菜单

应用引入系统托盘后，关闭主窗口（标题栏 X）不再退出进程，而是隐藏窗口驻留托盘，任务后台继续执行；退出屏障（保存 flush + 运行中任务确认）只在托盘菜单「退出」或系统关机时触发。同时新增单实例锁（`requestSingleInstanceLock`，第二实例激活已有窗口后自行退出）与开机启动偏好（默认关，`app.setLoginItemSettings` 零新依赖，随登录静默驻留托盘不弹窗）。仅 Windows 产线支持与验收。

## Considered Options

- 关闭即退出（现行为）：放弃——任务后台继续跑是驻留型桌面 agent 的核心价值。
- 首次点 X 弹窗询问（QQ/Steam 式）：放弃——多一个对话框与设置项，行为不可预期；采用「总是直接驻留 + 首次托盘气泡提示一次」。
- 三平台对齐：放弃——无 mac/linux 打包目标，且 mac 的 close-to-tray 语义本来不同。

## Consequences

- `close` 事件被全部拦截为 `hide`，进程只能从托盘菜单「退出」发起退出——阅读 lifecycle 代码时勿把这一点「修复」回去；`window-all-closed → app.quit()` 保留给系统关机场景。
- 已知边界：若系统关机时窗口 `close` 先于 `before-quit` 到达，驻留拦截会把关机变成「隐藏后等待」，由 Windows 超时强杀——此时退出屏障不跑，靠启动现场「随状态变化持续保存、不依赖正常退出」（GLOSSARY）兜底，仅丢防抖窗口内的尾部写。
- 开机启动经 `setLoginItemSettings` 的 `args` 传 `--hidden` 标志实现静默驻留；开发模式（未打包 exe）下禁写，避免把 electron.exe 注册进登录项。
- 单实例锁仅在打包环境启用（同一 dev 防线）：开发/e2e 的 electron.exe 共用默认 userData，启用会把本机并行实例误判成第二实例。
