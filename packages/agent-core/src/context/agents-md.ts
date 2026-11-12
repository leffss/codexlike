import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { captureResourceFile, readCapturedBytes } from "./resource-files";

/**
 * AGENTS.md 发现与系统提示组装（spec「上下文管理」：全局 + 项目根 → cwd 逐层，
 * 每目录取一个、按层拼接，总量 32 KiB 截断）。
 * 依赖 Node 内置 API，经 `./node` 出口暴露（主出口保持浏览器安全）；
 * fs 与 git 根探测可注入（测试与无 git 环境退化）。
 */

/** 拼接总量的字节上限（32 KiB） */
export const AGENTS_MD_MAX_BYTES = 32 * 1024;

export interface AgentsMdSection {
  /** `global` = 全局 `~/.codexlike/AGENTS.md`；`project` = 项目内某目录 */
  source: "global" | "project";
  /** 文件绝对路径（/status 展示来源用） */
  path: string;
  content: string;
  /** 可选以兼容已有调用方手工组装的 section。 */
  bytes?: number;
  includedBytes?: number;
}

export interface AgentsMdDiscovery {
  /** 按注入顺序（全局 → 项目根 → … → cwd）命中的各层 */
  sections: AgentsMdSection[];
  /** 拼接后的规范文本（含分节头）；超限截断到 32 KiB；无命中为空串 */
  combined: string;
  truncated: boolean;
  diagnostics?: { path: string; message: string }[];
}

export interface DiscoverAgentsInstructionsOptions {
  /** 全局目录；默认 CODEXLIKE_HOME（02 的 E2E 隔离钩子）或 ~/.codexlike */
  globalDir?: string;
  /** 会话绑定的工作区目录 */
  workspacePath: string;
  /** 逐层遍历的终点（默认工作区目录本身） */
  cwd?: string;
  /** git 根探测；默认 `git rev-parse --show-toplevel`，非 git 仓库返回 null */
  findGitRoot?: (dir: string) => string | null;
  /** 文件读取；默认 node:fs，不存在/不可读返回 null */
  readFile?: (path: string) => string | null;
}

/** 路径归一：统一分隔符，Windows 上大小写不敏感比较 */
function normalizePath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function defaultFindGitRoot(dir: string): string | null {
  try {
    const output = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const root = output.trim();
    return root === "" ? null : root;
  } catch {
    return null;
  }
}

/** 项目层链：root（含）→ cwd（含）的每一层目录；cwd 不在 root 下时退化为 [cwd] */
export function projectLayerDirs(root: string, cwd: string): string[] {
  if (normalizePath(root) === normalizePath(cwd)) {
    return [root];
  }
  const rel = relative(root, cwd);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return [cwd];
  }
  const dirs = [root];
  let acc = root;
  for (const part of rel.split(/[\\/]/)) {
    acc = join(acc, part);
    dirs.push(acc);
  }
  return dirs;
}

/** 按 UTF-8 字节截断，不切半个字符（不产生替换符 U+FFFD） */
function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  let out = "";
  let used = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (used + charBytes > maxBytes) {
      break;
    }
    out += char;
    used += charBytes;
  }
  return out;
}

/**
 * 发现并拼接 AGENTS.md。
 * 顺序：全局 → git 根（无 git 则工作区目录）→ … → cwd，每目录至多一个文件。
 */
export function discoverAgentsInstructions(
  options: DiscoverAgentsInstructionsOptions
): AgentsMdDiscovery {
  const {
    workspacePath,
    cwd = workspacePath,
    findGitRoot = defaultFindGitRoot,
  } = options;
  const diagnostics: { path: string; message: string }[] = [];
  const fileBytes = new Map<string, number>();
  const readFile = (path: string): string | null => {
    try {
      if (options.readFile) return options.readFile(path);
      const file = captureResourceFile(path, dirname(path));
      fileBytes.set(path, file.bytes);
      const bytes = readCapturedBytes(file, AGENTS_MD_MAX_BYTES);
      // 上限可能落在 UTF-8 多字节字符内，stream 仅保留完整字符。
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
        stream: file.bytes > bytes.length,
      });
      // eslint-disable-next-line no-control-regex -- 字符类需要匹配控制字符本体：这是「拒绝二进制规范文件」的判定依据
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
        throw new Error("拒绝二进制规范文件");
      return text;
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        diagnostics.push({
          path,
          message: `无法读取规范：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return null;
    }
  };
  const globalDir =
    options.globalDir ??
    process.env.CODEXLIKE_HOME ??
    join(homedir(), ".codexlike");

  const sections: AgentsMdSection[] = [];

  const globalContent = readFile(join(globalDir, "AGENTS.md"));
  if (globalContent !== null && globalContent !== "") {
    sections.push({
      source: "global",
      path: join(globalDir, "AGENTS.md"),
      content: globalContent,
    });
  }

  // 项目根：git 根（须包含 cwd，否则视为退化）；无 git 用工作区目录
  const gitRoot = findGitRoot(workspacePath);
  const normalizedRoot = gitRoot === null ? null : normalizePath(gitRoot);
  const normalizedCwd = normalizePath(cwd);
  const rootInsideGit =
    normalizedRoot !== null &&
    (normalizedRoot === normalizedCwd ||
      normalizedCwd.startsWith(`${normalizedRoot}/`));
  const root = rootInsideGit && gitRoot !== null ? gitRoot : workspacePath;
  for (const dir of projectLayerDirs(root, cwd)) {
    const content = readFile(join(dir, "AGENTS.md"));
    if (content !== null && content !== "") {
      sections.push({
        source: "project",
        path: join(dir, "AGENTS.md"),
        content,
      });
    }
  }

  if (sections.length === 0) {
    return { sections, combined: "", truncated: false, diagnostics };
  }

  let combined =
    "# 用户与项目规范（AGENTS.md）\n\n以下规范自动收集自 AGENTS.md 文件，请遵守。\n\n";
  for (const [index, section] of sections.entries()) {
    const header = `${index === 0 ? "" : "\n\n"}## ${section.source === "global" ? "全局规范" : "项目规范"}\n\n来源：${section.path}\n\n`;
    const available = Math.max(
      0,
      AGENTS_MD_MAX_BYTES -
        Buffer.byteLength(combined) -
        Buffer.byteLength(header)
    );
    section.bytes =
      fileBytes.get(section.path) ?? Buffer.byteLength(section.content);
    section.includedBytes = Buffer.byteLength(
      truncateUtf8(section.content, available)
    );
    if (section.includedBytes < section.bytes) {
      diagnostics.push({
        path: section.path,
        message: `规范超过 32 KiB 总量限制，正文仅注入 ${section.includedBytes}/${section.bytes} 字节`,
      });
    }
    combined += header + section.content;
  }
  const truncated = Buffer.byteLength(combined) > AGENTS_MD_MAX_BYTES;
  return {
    sections,
    combined: truncateUtf8(combined, AGENTS_MD_MAX_BYTES),
    truncated,
    diagnostics,
  };
}

/**
 * 把发现结果组装为会话系统提示。
 * 无 AGENTS.md 时返回空串（不注入系统提示，保持既有消息流行为）；
 * 有则注入拼接后的规范文本。后续若需要基础身份提示，在此处统一追加。
 */
export function composeSystemPrompt(discovery: AgentsMdDiscovery): string {
  return discovery.combined;
}
