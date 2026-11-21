/**
 * 终端会话的环境变量白名单过滤（ADR 0033 票03）：PTY 子进程只拿基础项，
 * 不透传完整宿主环境（密钥类变量会经 PTY 暴露给会话内任意程序与输出）。
 *
 * 名单与过滤函数的单一来源是 agent-core 的 ENV_ALLOWLIST / filterEnv
 * （tools/terminal.ts，经 /node 出口导出；code review 修复轮统一，替换
 * 原先两处逐字同款的本地副本）。本文件保留为转发壳：调用点签名
 * （filterSessionEnv）不变。
 */

export { filterEnv as filterSessionEnv } from "@codexlike/agent-core/node";
