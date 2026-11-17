import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createNodeProbeEnv,
  resolveOpeners,
  type OpenerProbeEnv,
} from "../../src/openers/opener-resolver";

/**
 * 工作区打开器探测解析器：注入假环境（目录/文件存在性、PATH、安装根目录）
 * 断言候选可用性——explorer 恒在，其余按本机探测结果出现/隐藏。
 * Windows 优先（共识）：LOCALAPPDATA / ProgramFiles / PATH 三路探测。
 */

/** 内存文件系统假环境：files 记录存在的绝对路径，dirs 记录目录可列出项 */
function fakeEnv(
  files: string[],
  dirs: Record<string, string[]>,
  overrides: Partial<OpenerProbeEnv> = {}
): OpenerProbeEnv {
  const fileSet = new Set(files);
  return {
    localAppData: "C:\\Users\\tester\\AppData\\Local",
    programFiles: "C:\\Program Files",
    pathEntries: [],
    exists: (p) => fileSet.has(p),
    readDir: (p) => dirs[p] ?? null,
    ...overrides,
  };
}

describe("resolveOpeners", () => {
  it("explorer 恒在且置首（系统 shell 打开，无 exe）；无任何安装时其余隐藏", () => {
    const openers = resolveOpeners(fakeEnv([], {}));
    expect(openers.map((o) => o.id)).toEqual(["explorer"]);
    const explorer = openers[0];
    if (!explorer) throw new Error("explorer 恒在，不应为空");
    expect(explorer.exePath).toBeNull();
  });

  it("VS Code：用户装（LOCALAPPDATA）与系统装（ProgramFiles）都识别，用户装优先", () => {
    const user = join(
      "C:\\Users\\tester\\AppData\\Local",
      "Programs",
      "Microsoft VS Code",
      "Code.exe"
    );
    expect(resolveOpeners(fakeEnv([user], {})).map((o) => o.id)).toEqual([
      "explorer",
      "vscode",
    ]);
    expect(
      resolveOpeners(fakeEnv([user], {})).find((o) => o.id === "vscode")
        ?.exePath
    ).toBe(user);

    const system = join("C:\\Program Files", "Microsoft VS Code", "Code.exe");
    expect(
      resolveOpeners(fakeEnv([system], {})).find((o) => o.id === "vscode")
        ?.exePath
    ).toBe(system);
  });

  it("VS Code：PATH 目录内 Code.exe 也识别（最低优先级）", () => {
    const onPath = join("D:\\tools\\bin", "Code.exe");
    const openers = resolveOpeners(
      fakeEnv([onPath], {}, { pathEntries: ["D:\\tools\\bin"] })
    );
    expect(openers.find((o) => o.id === "vscode")?.exePath).toBe(onPath);
  });

  it("JetBrains 家族：Toolbox 安装（apps/<slug>/ch-0/<版本>/bin/<exe>），多版本取最新", () => {
    const apps = join(
      "C:\\Users\\tester\\AppData\\Local",
      "JetBrains",
      "Toolbox",
      "apps"
    );
    const newer = join(apps, "PyCharm-P", "ch-0", "252.5678", "bin");
    const env = fakeEnv([join(newer, "pycharm64.exe")], {
      [join(apps, "PyCharm-P")]: ["ch-0"],
      [join(apps, "PyCharm-P", "ch-0")]: ["241.1234", "252.5678"],
    });
    expect(resolveOpeners(env).find((o) => o.id === "pycharm")?.exePath).toBe(
      join(newer, "pycharm64.exe")
    );
  });

  it("JetBrains 家族：独立安装（ProgramFiles\\JetBrains\\<产品 版本>\\bin\\<exe>），版本号按数值比较", () => {
    const root = join("C:\\Program Files", "JetBrains");
    const env = fakeEnv(
      [join(root, "WebStorm 2026.1", "bin", "webstorm64.exe")],
      {
        [root]: ["WebStorm 9.3", "WebStorm 2026.1"],
      }
    );
    expect(resolveOpeners(env).find((o) => o.id === "webstorm")?.exePath).toBe(
      join(root, "WebStorm 2026.1", "bin", "webstorm64.exe")
    );
  });

  it("探测不到的 JetBrains 产品不出现；可用项按固定顺序（explorer、terminal、vscode、pycharm、intellij、webstorm）", () => {
    const apps = join(
      "C:\\Users\\tester\\AppData\\Local",
      "JetBrains",
      "Toolbox",
      "apps"
    );
    const env = fakeEnv(
      [
        join("C:\\Program Files", "Microsoft VS Code", "Code.exe"),
        join(apps, "WebStorm", "ch-0", "252.1", "bin", "webstorm64.exe"),
      ],
      {
        [join(apps, "WebStorm")]: ["ch-0"],
        [join(apps, "WebStorm", "ch-0")]: ["252.1"],
      }
    );
    expect(resolveOpeners(env).map((o) => o.id)).toEqual([
      "explorer",
      "vscode",
      "webstorm",
    ]);
  });
});

describe("resolveOpeners：终端打开器（第一版 Windows-only）", () => {
  it("wt.exe 用户装（WindowsApps）优先：terminal 紧随 explorer（资源管理器下面），wt 启动风格", () => {
    const wt = join(
      "C:\\Users\\tester\\AppData\\Local",
      "Microsoft",
      "WindowsApps",
      "wt.exe"
    );
    const openers = resolveOpeners(fakeEnv([wt], {}));
    expect(openers.map((o) => o.id)).toEqual(["explorer", "terminal"]);
    expect(openers[1]).toMatchObject({
      exePath: wt,
      terminalStyle: "wt",
    });
  });

  it("wt.exe 经 PATH 目录也识别，且优先于偏好 shell（wt 恒第一优先）", () => {
    const wt = join("D:\\tools\\bin", "wt.exe");
    const bash = join("C:\\Program Files", "Git", "bin", "bash.exe");
    const openers = resolveOpeners(
      fakeEnv([wt, bash], {}, { pathEntries: ["D:\\tools\\bin"] }),
      { terminalShell: "powershell" }
    );
    expect(openers.find((o) => o.id === "terminal")).toMatchObject({
      exePath: wt,
      terminalStyle: "wt",
    });
  });

  it("无 wt：默认链落 Git Bash（bin\\bash.exe），cwd 继承启动风格", () => {
    const bash = join("C:\\Program Files", "Git", "bin", "bash.exe");
    const openers = resolveOpeners(fakeEnv([bash], {}));
    expect(openers.find((o) => o.id === "terminal")).toMatchObject({
      exePath: bash,
      terminalStyle: "inherit-cwd",
    });
  });

  it("偏好 powershell：wt 缺失时直接用 powershell.exe（SystemRoot 系统位）", () => {
    const powershell = join(
      "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    const env = fakeEnv([powershell], {}, { systemRoot: "C:\\Windows" });
    const openers = resolveOpeners(env, { terminalShell: "powershell" });
    expect(openers.find((o) => o.id === "terminal")).toMatchObject({
      exePath: powershell,
      terminalStyle: "inherit-cwd",
    });
  });

  it("偏好 shell 未安装时沿固定链退化（git-bash 缺 → powershell 缺 → cmd）", () => {
    const cmd = join("C:\\Windows", "System32", "cmd.exe");
    const env = fakeEnv([cmd], {}, { systemRoot: "C:\\Windows" });
    const openers = resolveOpeners(env, { terminalShell: "git-bash" });
    expect(openers.find((o) => o.id === "terminal")).toMatchObject({
      exePath: cmd,
      terminalStyle: "inherit-cwd",
    });
  });

  it("无 systemRoot 时 PowerShell/cmd 也可经 PATH 目录识别", () => {
    const powershell = join("D:\\sh", "powershell.exe");
    const openers = resolveOpeners(
      fakeEnv([powershell], {}, { pathEntries: ["D:\\sh"] })
    );
    expect(openers.find((o) => o.id === "terminal")?.exePath).toBe(powershell);
  });

  it("PATH 上的 bash.exe 不当 Git Bash（防命中 System32 的 WSL 启动器）：Git 未装时沿链落 powershell", () => {
    const wslBash = join("C:\\Windows", "System32", "bash.exe");
    const powershell = join(
      "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    const env = fakeEnv(
      [wslBash, powershell],
      {},
      { systemRoot: "C:\\Windows" }
    );
    const openers = resolveOpeners(env);
    expect(openers.find((o) => o.id === "terminal")?.exePath).toBe(powershell);
  });

  it("Git Bash 也认 32 位安装位（ProgramFiles(x86)）", () => {
    const bash = join("C:\\Program Files (x86)", "Git", "bin", "bash.exe");
    const env = fakeEnv(
      [bash],
      {},
      { programFilesX86: "C:\\Program Files (x86)" }
    );
    const openers = resolveOpeners(env);
    expect(openers.find((o) => o.id === "terminal")).toMatchObject({
      exePath: bash,
      terminalStyle: "inherit-cwd",
    });
  });

  it("Windows 上一个终端都探测不到：terminal 不出现，explorer 恒在", () => {
    expect(
      resolveOpeners(fakeEnv([], {}), { platform: "win32" }).map((o) => o.id)
    ).toEqual(["explorer"]);
  });

  it("非 Windows 平台：终端项隐藏（第一版 Windows-only）", () => {
    const bash = join("C:\\Program Files", "Git", "bin", "bash.exe");
    expect(
      resolveOpeners(fakeEnv([bash], {}), { platform: "darwin" }).map(
        (o) => o.id
      )
    ).toEqual(["explorer"]);
  });
});

describe("createNodeProbeEnv", () => {
  it("从当前进程环境构建（PATH 按分隔符拆分、空段剔除），exists/readDir 不抛", () => {
    const env = createNodeProbeEnv();
    expect(Array.isArray(env.pathEntries)).toBe(true);
    expect(env.pathEntries.every((entry) => entry.length > 0)).toBe(true);
    expect(typeof env.exists("C:\\__definitely_missing__")).toBe("boolean");
    expect(env.readDir("C:\\__definitely_missing__")).toBeNull();
  });
});
