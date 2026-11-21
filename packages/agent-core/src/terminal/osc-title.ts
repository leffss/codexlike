/**
 * OSC 0/2 标题增量扫描器（标题功能轮）：PTY 字节按任意分片到达，转义序列
 * 可能跨 chunk 拆开（conpty 转发不保序对齐），本扫描器是有状态纯逻辑——
 * feed 每个输出分片，识别到完整的 OSC 0（图标+窗口标题）/ OSC 2（窗口
 *标题）序列时返回标题文本，其余返回 null。浏览器安全（无 IO 依赖）。
 *
 * 语法（ECMA-48 / xterm 实作）：`ESC ] Ps ; Pt BEL` 或 `ESC ] Ps ; Pt ESC \`。
 * 只消费标题序列本体，其余字节（CSI、DCS、普通输出）原样穿过不累积——
 * 扫描器与字节流转发（onSessionData 直写 xterm.js）互不干扰，不改变缓冲。
 *
 * 过滤口径（conpty 初始标题回声）：Windows 启动 shell 时 conpty 会先发一
 * 条「可执行文件绝对路径」标题（如 `C:\Windows\...\powershell.exe`），是
 * 宿主回声而非 shell 自选标题，呈现价值为负——匹配盘符开头的 .exe 结尾
 * 绝对路径的标题不产出；git-bash 的 `MINGW64:/tmp`、cmd 的 `cmd.exe` 等
 * shell 自选标题照常产出。
 */

/** OSC 序列终止符：BEL（7-bit）或 ST（ESC \） */
const BEL = "\u0007";
const ESC = "\u001b";

/** 标题字符上限（与 TERMINAL_TITLE_MAX_CHARS 同口径；超长直接丢弃该条） */
const OSC_TITLE_MAX_CHARS = 200;

type ScannerState = "ground" | "esc" | "body" | "st";

export interface OscTitleScanner {
  /** 喂入一个输出分片；识别到完整 OSC 0/2 标题时返回标题文本，否则 null */
  feed(chunk: string): string | null;
}

/** conpty 初始标题回声：盘符绝对路径 + .exe 结尾（如 C:\Windows\...\bash.exe） */
function isExePathEcho(title: string): boolean {
  return /^[A-Za-z]:\\.*\.exe$/.test(title);
}

export function createOscTitleScanner(): OscTitleScanner {
  let state: ScannerState = "ground";
  let body = "";

  /** OSC 体 → 标题文本；非 0/2 序列或超长回声返回 null */
  function dispatch(): string | null {
    const semicolon = body.indexOf(";");
    if (semicolon <= 0) return null;
    const code = body.slice(0, semicolon);
    const title = body.slice(semicolon + 1);
    if (code !== "0" && code !== "2") return null;
    if (title === "" || title.length > OSC_TITLE_MAX_CHARS) return null;
    if (isExePathEcho(title)) return null;
    return title;
  }

  return {
    feed(chunk) {
      // 同一 chunk 可能连发多条标题序列（罕见但合法）：只保留最后一条
      let found: string | null = null;
      for (const char of chunk) {
        if (state === "ground") {
          if (char === ESC) state = "esc";
        } else if (state === "esc") {
          if (char === "]") {
            state = "body";
            body = "";
          } else {
            // CSI / DCS 等其他转义序列：不消费，回地面
            state = char === ESC ? "esc" : "ground";
          }
        } else if (state === "body") {
          if (char === BEL) {
            state = "ground";
            const title = dispatch();
            body = "";
            if (title !== null) found = title;
          } else if (char === ESC) {
            state = "st";
          } else {
            body += char;
          }
        } else {
          // st：等待 ESC \ 的反斜杠
          if (char === "\\") {
            state = "ground";
            const title = dispatch();
            body = "";
            if (title !== null) found = title;
          } else {
            // ESC 后跟其他字符：序列畸形，回地面继续扫
            state = char === ESC ? "esc" : "ground";
            body = "";
          }
        }
      }
      return found;
    },
  };
}
