import { accessSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { OpenerId } from "./opener-settings-store";

/**
 * 工作区打开器探测解析器：按注入的探测环境折算候选可用性。
 * explorer 走 Electron shell.openPath（跨平台文件管理器），恒可用置首；
 * 编辑器类按「用户安装 → 系统安装 → PATH 目录」顺序探测真实 exe。
 * Windows 优先（共识）：LOCALAPPDATA / ProgramFiles / PATH 三路；
 * 接缝即 OpenerProbeEnv，macOS/Linux 补充时新增构建器不改本逻辑。
 * 注：不探测 code.cmd / charm 等 CLI 脚本——Windows 上 spawn 脚本需
 * shell:true（拼接引号注入面）或直接 EINVAL，只认真实 exe。
 */

/** 探测环境接缝：生产用 createNodeProbeEnv，测试注入内存假环境 */
export interface OpenerProbeEnv {
  /** Windows：%LOCALAPPDATA%（VS Code 用户装 / JetBrains Toolbox） */
  localAppData: string | null;
  /** Windows：%ProgramFiles%（VS Code 系统装 / JetBrains 独立安装） */
  programFiles: string | null;
  /** PATH 已拆分的目录列表 */
  pathEntries: readonly string[];
  exists(path: string): boolean;
  /** 目录不存在返回 null */
  readDir(path: string): string[] | null;
}

/** 探测到的打开器；explorer 无 exe（shell 打开） */
export interface ResolvedOpener {
  id: OpenerId;
  /** 可直接 spawn 的 exe 绝对路径；explorer 为 null */
  exePath: string | null;
}

/** JetBrains 产品探测参数：Toolbox 应用目录 slug 候选 + 独立安装目录前缀 + exe 名 */
interface JetBrainsProbe {
  toolboxSlugs: readonly string[];
  standalonePrefix: string;
  exeName: string;
}

const JETBRAINS: Record<"pycharm" | "intellij" | "webstorm", JetBrainsProbe> = {
  pycharm: {
    // Toolbox 1.x 用产品全名目录，2.x 用短 slug；专业/社区两个发行各自可装
    toolboxSlugs: [
      "PyCharm-P",
      "PyCharm-C",
      "pycharm",
      "pycharm-professional",
      "pycharm-community",
    ],
    standalonePrefix: "PyCharm",
    exeName: "pycharm64.exe",
  },
  intellij: {
    toolboxSlugs: [
      "IntelliJ IDEA Ultimate",
      "IntelliJ IDEA Community",
      "intellij-idea-ultimate",
      "intellij-idea-community",
    ],
    standalonePrefix: "IntelliJ IDEA",
    exeName: "idea64.exe",
  },
  webstorm: {
    toolboxSlugs: ["WebStorm", "webstorm"],
    standalonePrefix: "WebStorm",
    exeName: "webstorm64.exe",
  },
};

/** 顺序敏感的目录名比较（数值感知）：数字段按数值比，其余字典序 */
function compareDirNamesDesc(a: string, b: string): number {
  const parts = (value: string) =>
    value
      .split(/(\d+)/)
      .map((part, index) =>
        index % 2 === 1 ? { num: Number(part) } : { text: part.toLowerCase() }
      );
  const left = parts(a);
  const right = parts(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l.num !== undefined && r.num !== undefined) {
      if (l.num !== r.num) return r.num - l.num;
    } else if (l.num !== undefined) {
      return 1; // 数字段 > 文本段（"2026.1" vs "stable"：版本号优先）
    } else if (r.num !== undefined) {
      return -1;
    } else if (l.text !== r.text) {
      return l.text < r.text ? 1 : -1;
    }
  }
  return 0;
}

/** 取列表中第一个存在的路径 */
function firstExisting(env: OpenerProbeEnv, paths: string[]): string | null {
  for (const path of paths) {
    if (env.exists(path)) return path;
  }
  return null;
}

/** VS Code exe 探测：用户装 → 系统装 → PATH 目录 */
function resolveVscode(env: OpenerProbeEnv): string | null {
  const candidates: string[] = [];
  if (env.localAppData !== null) {
    candidates.push(
      join(env.localAppData, "Programs", "Microsoft VS Code", "Code.exe")
    );
  }
  if (env.programFiles !== null) {
    candidates.push(join(env.programFiles, "Microsoft VS Code", "Code.exe"));
  }
  for (const entry of env.pathEntries) {
    candidates.push(join(entry, "Code.exe"));
  }
  return firstExisting(env, candidates);
}

/**
 * JetBrains 单产品探测：Toolbox（apps/<slug>，支持 ch-0/<版本> 分层与
 * 直挂 bin）→ 独立安装（ProgramFiles\JetBrains\<产品 版本>\bin）→ PATH。
 */
function resolveJetbrains(
  env: OpenerProbeEnv,
  probe: JetBrainsProbe
): string | null {
  // Toolbox：逐 slug 找到已安装目录，再在其中挑最新版本的 bin exe
  const appsRoot =
    env.localAppData === null
      ? null
      : join(env.localAppData, "JetBrains", "Toolbox", "apps");
  if (appsRoot !== null) {
    for (const slug of probe.toolboxSlugs) {
      const appDir = join(appsRoot, slug);
      const direct = firstExisting(env, [join(appDir, "bin", probe.exeName)]);
      if (direct !== null) return direct;
      // 通道目录（ch-0…）→ 版本目录 → bin；通道/版本各取字典+数值最新。
      // 排序一律在拷贝上做（readDir 结果可能被注入环境复用，不就地改序）。
      const channels = env.readDir(appDir);
      if (channels === null) continue;
      for (const channel of [...channels]
        .filter((name) => name.startsWith("ch-"))
        .sort(compareDirNamesDesc)) {
        const versions = env.readDir(join(appDir, channel));
        if (versions === null) continue;
        const exe = firstExisting(
          env,
          [...versions]
            .sort(compareDirNamesDesc)
            .map((version) =>
              join(appDir, channel, version, "bin", probe.exeName)
            )
        );
        if (exe !== null) return exe;
      }
    }
  }
  // 独立安装：产品目录带版本号后缀，按数值最新挑
  const standaloneRoot =
    env.programFiles === null ? null : join(env.programFiles, "JetBrains");
  if (standaloneRoot !== null) {
    const productDirs = env.readDir(standaloneRoot);
    if (productDirs !== null) {
      const exe = firstExisting(
        env,
        productDirs
          .filter((name) =>
            name.toLowerCase().startsWith(probe.standalonePrefix.toLowerCase())
          )
          .sort(compareDirNamesDesc)
          .map((name) => join(standaloneRoot, name, "bin", probe.exeName))
      );
      if (exe !== null) return exe;
    }
  }
  // PATH 目录内的产品 exe（自定义安装位置自行入 PATH 的场景）
  return firstExisting(
    env,
    env.pathEntries.map((entry) => join(entry, probe.exeName))
  );
}

/** 探测可用的工作区打开器（固定顺序；explorer 恒在置首，未探测到的隐藏） */
export function resolveOpeners(env: OpenerProbeEnv): ResolvedOpener[] {
  const resolved: ResolvedOpener[] = [{ id: "explorer", exePath: null }];
  const vscode = resolveVscode(env);
  if (vscode !== null) resolved.push({ id: "vscode", exePath: vscode });
  // JETBRAINS 键序即菜单顺序（pycharm → intellij → webstorm），单一来源
  for (const id of Object.keys(JETBRAINS) as (keyof typeof JETBRAINS)[]) {
    const exePath = resolveJetbrains(env, JETBRAINS[id]);
    if (exePath !== null) resolved.push({ id, exePath });
  }
  return resolved;
}

/** 生产探测环境：从当前进程 env 与文件系统构建 */
export function createNodeProbeEnv(): OpenerProbeEnv {
  return {
    localAppData: process.env.LOCALAPPDATA ?? null,
    programFiles: process.env.ProgramFiles ?? null,
    pathEntries: (process.env.PATH ?? "").split(delimiter).filter(Boolean),
    exists(path) {
      try {
        accessSync(path);
        return true;
      } catch {
        return false;
      }
    },
    readDir(path) {
      try {
        return readdirSync(path);
      } catch {
        return null;
      }
    },
  };
}
