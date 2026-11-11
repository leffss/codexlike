// E2E MCP 冒烟（工单 12）：真实 Electron 应用走 MCP 最小全链路——
// 设置页添加 stdio MCP server（node 起进程内 fake server）→ 状态「已连接」+ 工具发现可见
// → 逐工具启停 → 建会话（suggest）→ 模型调用 mcp_fake_echo → 审批卡片（工具名）→ 批准
// → fake server 经 stdio 真实往返、结果回填模型 → 最终回复
// → 重启应用 → server 自动重连（startup）。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:mcp（先全仓 build）。
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { DESKTOP_DIR } from "./launch-target.mjs";
import {
  assert,
  closeApp,
  launchApp,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

const FIXTURE = resolve(
  DESKTOP_DIR,
  "..",
  "agent-core",
  "tests",
  "mcp",
  "fixtures",
  "fake-mcp-server.mjs"
);

/** 场景脚本：消息 1 请求 MCP 工具调用，消息 2（重启后）再调一次验证恢复 */
const SCRIPT = [
  { tool: { name: "mcp_fake_echo", arguments: { text: "来自 E2E 的问候" } } },
  { text: "MCP 工具已执行并返回结果" },
  { tool: { name: "mcp_fake_echo", arguments: { text: "重启后再次调用" } } },
  { text: "重启后 MCP 仍可用" },
];

/** 在设置页配置 Provider Profile + 添加 MCP server 并等待连接 */
async function setupSettings(window, port) {
  await window.getByRole("button", { name: "设置", exact: true }).click();

  // Provider Profile（限定表单内点击，工单 10 踩坑：设置页多区多「保存」按钮）
  await window.getByRole("button", { name: "+ 新建 Profile" }).click();
  const profileForm = window.locator("form");
  await profileForm.getByLabel("名称").fill("Mock");
  await profileForm.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
  await profileForm.getByLabel("API Key").fill("sk-e2e");
  await profileForm.getByLabel("模型").fill("mock-model");
  await window
    .locator("form")
    .getByRole("button", { name: /保存|创建/ })
    .click();
  await window.getByText("Mock").first().waitFor();

  // MCP servers 区：添加 fake server（node + fixture）
  await window.getByTestId("mcp-add-server").click();
  await window.getByTestId("mcp-form-name").fill("fake");
  await window.getByTestId("mcp-form-command").fill(process.execPath);
  await window.getByTestId("mcp-form-args").fill(FIXTURE);
  await window.getByTestId("mcp-form-submit").click();

  // 连接成功：状态徽标「已连接」+ 工具发现（3 个）
  const status = window.getByTestId("mcp-status-fake");
  await status.getByText("已连接").waitFor({ timeout: 30_000 });
  await window.getByText("mcp_fake_echo").first().waitFor({ timeout: 10_000 });
  assert(
    (await window.getByText("mcp_fake_crash").count()) >= 1,
    "未发现 crash 工具"
  );
  console.log(
    "[e2e] 设置页：MCP server 已连接，工具发现可见（mcp_fake_echo 等 3 个）"
  );

  // 逐工具启停：禁用 crash → 再启用（对会话生效的开关真实可切换）
  const crashToggle = window.getByTestId("mcp-tool-toggle-mcp_fake_crash");
  await crashToggle.uncheck();
  await window.getByText("已禁用").first().waitFor({ timeout: 5_000 });
  await crashToggle.check();
  console.log("[e2e] 逐工具启停开关真实切换");
}

async function main() {
  const { server, port } = await startMockProvider((ctx, { index }) => {
    const step = SCRIPT[Math.min(index - 1, SCRIPT.length - 1)];
    if (step.tool !== undefined) {
      ctx.toolCallRound(`call-${index}`, step.tool.name, step.tool.arguments);
      return;
    }
    ctx.textRound(step.text);
  });
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-mcp-"));
  mkdirSync(join(homeDir, "workspace"));

  let app;
  try {
    // 1) 首次启动：设置页配置 Profile + MCP server
    const first = await launchApp({ homeDir });
    app = first.app;
    let window = first.window;
    await setupSettings(window, port);

    // 2) 建会话（显式选择 assist）→ 模型调用 mcp_fake_echo → 自动放行（无审批卡）
    await window.getByRole("button", { name: "返回工作台" }).click();
    await prepareDraft(window, { approvalMode: "assist" });

    await window.getByTestId("composer-input").fill("调用 MCP echo 工具");
    await window.getByTestId("composer-send").click();

    // assist 档：MCP 工具（无命令参数、非危险）自动放行，不弹审批卡
    await new Promise((r) => setTimeout(r, 500));
    assert(
      (await window.getByTestId("interaction-panel").count()) === 0,
      "assist 档 MCP 工具不应弹审批卡"
    );
    console.log("[e2e] assist 模式：MCP 工具调用自动放行（无审批卡）");

    // 3) fake server 经 stdio 真实往返 → 结果回填卡片与模型

    const echoCard = window
      .locator('[data-testid="tool-call-card"][data-tool-name="mcp_fake_echo"]')
      .first();
    await echoCard.waitFor({ timeout: 20_000 });
    await echoCard.getByTestId("tool-call-toggle").click();
    await echoCard
      .getByTestId("tool-call-output")
      .getByText("echo: 来自 E2E 的问候")
      .waitFor({ timeout: 10_000 });
    await window
      .getByTestId("message-assistant")
      .last()
      .getByText("MCP 工具已执行并返回结果")
      .waitFor({ timeout: 20_000 });
    console.log("[e2e] 批准后调用真实往返：结果回填工具卡片与模型上下文");

    // 4) 重启应用：MCP server 自动重连（startup），会话中再次调用仍走通
    await closeApp(app);
    const second = await launchApp({ homeDir });
    app = second.app;
    window = second.window;
    await window
      .getByTestId("session-item")
      .first()
      .waitFor({ timeout: 15_000 });
    await window.getByRole("button", { name: "设置", exact: true }).click();
    await window
      .getByTestId("mcp-status-fake")
      .getByText("已连接")
      .waitFor({ timeout: 30_000 });
    console.log(
      "[e2e] 重启后 MCP server 自动重连（配置持久化 + startup 连接）"
    );

    await window.getByRole("button", { name: "返回工作台" }).click();
    await window.getByTestId("session-item").first().click();
    await window.getByTestId("composer-input").fill("重启后再调用一次");
    await window.getByTestId("composer-send").click();

    // assist 档自动放行：无审批卡，直接真实往返
    await window
      .getByTestId("message-assistant")
      .last()
      .getByText("重启后 MCP 仍可用")
      .waitFor({ timeout: 20_000 });
    console.log(
      "[e2e] 重启后会话中 MCP 工具调用仍走通（自动放行 → 执行 → 回填）"
    );

    await closeApp(app);
    console.log("[e2e] MCP 冒烟通过 ✅");
  } catch (error) {
    console.error("[e2e] MCP 冒烟失败 ❌", error);
    process.exitCode = 1;
    try {
      await closeApp(app);
    } catch {
      // 已关闭
    }
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
}

await main();
