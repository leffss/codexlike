import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 本包含真实 Git、stdio 和浏览器进程；按机器核数无限并发会挤占进程启动预算。
    // 保持逐例超时不变，用有界 worker 避免 Windows 全测超时而单跑通过。
    maxWorkers: 4,
  },
});
