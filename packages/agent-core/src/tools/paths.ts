/**
 * Windows ↔ POSIX 路径转换（spec：转换在工具层完成）。
 * 工具输出给模型/用户的路径统一 POSIX 风格（正斜杠），避免反斜杠转义歧义。
 */

/** 展示用路径：反斜杠 → 正斜杠 */
export function toDisplayPath(path: string): string {
  return path.replaceAll('\\', '/');
}

/**
 * Windows 绝对路径 → Git Bash 的 POSIX 绝对路径（`C:\x` → `/c/x`，UNC `\\server\share` → `//server/share`）。
 * 非 Windows 形态原样返回。
 */
export function windowsToPosixAbsolute(path: string): string {
  // UNC 路径（\\server\share 或 //server/share 开头）：仅统一分隔符，保留双斜杠
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    return path.replaceAll('\\', '/');
  }
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (match === null) {
    return path.replaceAll('\\', '/');
  }
  const drive = match[1]!.toLowerCase();
  const rest = match[2]!.replaceAll('\\', '/');
  return `/${drive}/${rest}`;
}

/**
 * POSIX 绝对路径 → Windows 绝对路径（`/c/x` → `C:\x`）；非 `/盘符/` 形态原样返回。
 */
export function posixToWindowsAbsolute(path: string): string {
  const match = /^\/([A-Za-z])\/(.*)$/.exec(path);
  if (match === null) {
    return path;
  }
  const drive = match[1]!.toUpperCase();
  const rest = match[2]!.replaceAll('/', '\\');
  return `${drive}:\\${rest}`;
}
