# Electron 桌面应用（而非 web-first 或 Tauri）

产品定位是「本地 coding agent 工作台」，用户明确要求直接做成桌面应用。在 web-first（本地 Node 服务 + 浏览器访问，后期套壳）、Electron、Tauri 三个选项中，选定 **Electron**：主进程承载 agent loop 与工具执行（Node 环境直接用 `fs`/`child_process`），渲染进程为 React UI。代价是包体与内存占用大于 Tauri，换来的是最成熟的生态、单一 TS 语言栈和与 Node 工具链的无缝兼容。

## Considered Options

- **web-first + 浏览器**：工程量最小，但缺少原生窗口/托盘等桌面体验，被否决（用户要桌面应用）。
- **Tauri 2**：更轻，但 agent loop 需要Node sidecar 或改用 Rust，工程复杂度前移，生态较新。
- **Electron**：选定。
