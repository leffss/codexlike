/**
 * 终端会话的环境变量白名单过滤（ADR 0033 票03）：PTY 子进程只拿基础项，
 * 不透传完整宿主环境（密钥类变量会经 PTY 暴露给会话内任意程序与输出）。
 *
 * 名单与 agent-core run_terminal_command 的 ENV_ALLOWLIST 同款（tools/terminal.ts，
 * 工具层属 05 票领地本票不改动，故宿主侧独立维护；名单演进时两处同步，
 * 后续可统一到单一来源）。
 */

/** 环境变量白名单（大小写不敏感匹配键名） */
const SESSION_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMP",
  "TEMP",
  "TMPDIR",
  "TZ",
  "TERM",
  "USERPROFILE",
  "USERNAME",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
]);

/** 白名单过滤环境变量（undefined 值丢弃，保留原始键名大小写） */
export function filterSessionEnv(
  env: Record<string, string | undefined>
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && SESSION_ENV_ALLOWLIST.has(key.toUpperCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}
