// ADR 0027：全新隔离目录首次保存凭据后立即强杀，下一进程必须能够解密。
// 不预热、无固定等待、只用假凭据；Profile/Search/MCP 分别作为首个加密写入。
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, closeApp, launchApp } from "./helpers.mjs";

async function killTestApp(app) {
  const child = app.process();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  if (process.platform === "win32") {
    await new Promise((resolve, reject) =>
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], (error) =>
        error ? reject(error) : resolve()
      )
    );
  } else {
    child.kill("SIGKILL");
  }
  await exited;
}

async function scenario(kind) {
  const homeDir = mkdtempSync(join(tmpdir(), `codexlike-credential-${kind}-`));
  mkdirSync(join(homeDir, "workspace"));
  const secret = `synthetic-${kind}-${randomUUID()}-中文`;
  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    // 公开保存 Promise 成功即强杀，中间没有 sleep/正常退出/预热或额外模型请求。
    const savedId = await first.window.evaluate(
      async ({ kind, secret }) => {
        if (kind === "profile") {
          const saved = await window.codexlike.providerProfiles.create({
            name: "Credential Durability",
            baseURL: "http://127.0.0.1:9/v1",
            apiKey: secret,
            models: ["unused-model"],
          });
          return saved.id;
        }
        if (kind === "search") {
          await window.codexlike.searchSettings.set({ apiKey: secret });
          return null;
        }
        const saved = await window.codexlike.mcp.addServer({
          name: "Credential Durability",
          // 明确无网络、无真实工具；启动失败状态仍须完整保留加密配置。
          command: "codexlike-credential-test-nonexistent-command",
          args: [],
          env: { TEST_SYNTHETIC_CREDENTIAL: secret },
        });
        return saved.config.id;
      },
      { kind, secret }
    );
    await killTestApp(app);
    app = null;

    const file =
      kind === "profile"
        ? "provider-profiles.json"
        : kind === "search"
          ? "search-settings.json"
          : "mcp-servers.json";
    const before = readFileSync(join(homeDir, file), "utf8");
    assert(!before.includes(secret), `${kind} 凭据不得以明文落盘`);
    const second = await launchApp({ homeDir });
    app = second.app;
    const matches = await second.window.evaluate(
      async ({ kind, savedId, secret }) => {
        if (kind === "profile") {
          const records = await window.codexlike.providerProfiles.list();
          return (
            records.length === 1 &&
            records[0].id === savedId &&
            records[0].apiKey === secret
          );
        }
        if (kind === "search") {
          return (
            (await window.codexlike.searchSettings.get()).apiKey === secret
          );
        }
        const { servers } = await window.codexlike.mcp.overview();
        return (
          servers.length === 1 &&
          servers[0].config.id === savedId &&
          servers[0].config.env.TEST_SYNTHETIC_CREDENTIAL === secret
        );
      },
      { kind, savedId, secret }
    );
    assert(matches, `${kind} 首次保存后立即强杀，重启必须能解密相同凭据`);
    assert(
      readFileSync(join(homeDir, file), "utf8") === before,
      `${kind} 读取不得自动迁移或重写密文`
    );
    console.log(`[e2e] ${kind} 首次保存→立即强杀→新进程解密通过（无明文落盘）`);
  } finally {
    await closeApp(app);
    rmSync(homeDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

async function legacyCompatibility() {
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-credential-legacy-"));
  mkdirSync(join(homeDir, "workspace"));
  const secret = `synthetic-legacy-${randomUUID()}`;
  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    // 仅为旧格式兼容夹具生成真实Electron旧密文；耐久性三场景绝不走此路径。
    const encrypted = await app.evaluate(async ({ safeStorage }, value) => {
      if (!(await safeStorage.isAsyncEncryptionAvailable()))
        throw new Error("旧格式加密不可用");
      return (await safeStorage.encryptStringAsync(value)).toString("base64");
    }, secret);
    await closeApp(app);
    app = null;
    const files = {
      "provider-profiles.json": {
        profiles: [
          {
            id: "legacy-profile",
            name: "Legacy",
            baseURL: "http://127.0.0.1:9/v1",
            model: "legacy-model",
            encryptedApiKey: encrypted,
          },
        ],
      },
      "search-settings.json": {
        provider: "tavily",
        encryptedApiKey: encrypted,
      },
      "mcp-servers.json": {
        servers: [
          {
            id: "legacy-mcp",
            name: "Legacy",
            command: "codexlike-credential-test-nonexistent-command",
            args: [],
            encryptedEnv: { TEST_SYNTHETIC_CREDENTIAL: encrypted },
          },
        ],
        disabledTools: [],
      },
    };
    const originals = new Map();
    for (const [file, value] of Object.entries(files)) {
      const text = JSON.stringify(value);
      writeFileSync(join(homeDir, file), text);
      originals.set(file, text);
    }
    const second = await launchApp({ homeDir });
    app = second.app;
    const matches = await second.window.evaluate(async (value) => {
      const profiles = await window.codexlike.providerProfiles.list();
      const search = await window.codexlike.searchSettings.get();
      const mcp = await window.codexlike.mcp.overview();
      return (
        profiles[0]?.apiKey === value &&
        profiles[0]?.models[0] === "legacy-model" &&
        search.apiKey === value &&
        mcp.servers[0]?.config.env.TEST_SYNTHETIC_CREDENTIAL === value
      );
    }, secret);
    assert(matches, "三个旧格式凭据及旧单模型格式必须可读");
    for (const [file, original] of originals) {
      assert(
        readFileSync(join(homeDir, file), "utf8") === original,
        "读取旧格式不得自动迁移或重写"
      );
    }
    console.log("[e2e] 旧Electron密文只读兼容，不迁移文件");
  } finally {
    await closeApp(app);
    rmSync(homeDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

async function unreadableCredentials() {
  const homeDir = mkdtempSync(
    join(tmpdir(), "codexlike-credential-unreadable-")
  );
  mkdirSync(join(homeDir, "workspace"));
  const invalid = Buffer.from("invalid-synthetic-ciphertext").toString(
    "base64"
  );
  const originals = new Map([
    [
      "search-settings.json",
      JSON.stringify({ provider: "tavily", encryptedApiKey: invalid }),
    ],
    [
      "mcp-servers.json",
      JSON.stringify({
        servers: [
          {
            id: "unreadable",
            name: "Unreadable",
            command: "never-run",
            args: [],
            encryptedEnv: { TOKEN: invalid },
          },
        ],
        disabledTools: [],
      }),
    ],
  ]);
  for (const [file, text] of originals)
    writeFileSync(join(homeDir, file), text);
  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    await first.window.getByTestId("settings-open").click();
    await first.window.getByTestId("search-settings-retry").waitFor();
    await first.window.getByTestId("mcp-settings-retry").waitFor();
    assert(
      await first.window.getByTestId("mcp-add-server").isDisabled(),
      "MCP读取失败不能以默认空配置新增覆盖"
    );
    assert(
      (await first.window.getByTestId("search-api-key-save").count()) === 0,
      "搜索源读取失败不得保存默认空值"
    );
    for (const [file, original] of originals) {
      assert(
        readFileSync(join(homeDir, file), "utf8") === original,
        "不可解密配置必须原样保留"
      );
    }
    console.log("[e2e] 不可解密旧配置仍可建窗，设置可见错误且文件保持原样");
  } finally {
    await closeApp(app);
    rmSync(homeDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

for (const kind of ["profile", "search", "mcp"]) await scenario(kind);
await legacyCompatibility();
await unreadableCredentials();
console.log("[e2e] 凭据首次保存耐久性、旧格式兼容及失败保护通过");
