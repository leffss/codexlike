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

  it("探测不到的 JetBrains 产品不出现；可用项按固定顺序（explorer、vscode、pycharm、intellij、webstorm）", () => {
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

describe("createNodeProbeEnv", () => {
  it("从当前进程环境构建（PATH 按分隔符拆分、空段剔除），exists/readDir 不抛", () => {
    const env = createNodeProbeEnv();
    expect(Array.isArray(env.pathEntries)).toBe(true);
    expect(env.pathEntries.every((entry) => entry.length > 0)).toBe(true);
    expect(typeof env.exists("C:\\__definitely_missing__")).toBe("boolean");
    expect(env.readDir("C:\\__definitely_missing__")).toBeNull();
  });
});
