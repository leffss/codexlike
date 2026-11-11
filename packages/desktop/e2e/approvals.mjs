// 执行审批 E2E：保留 assist 自动放行/危险命令、full-access 风险确认和越界写、
// 重启档位恢复、ask 拒绝写入原场景。操作入口统一为底部 InteractionPanel，历史只读。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:approvals（先 build）。
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, closeApp, launchApp, startMockProvider } from "./helpers.mjs";

const script = (homeDir) => [
  {
    tool: {
      name: "run_terminal_command",
      arguments: { command: "echo assist-ok > assist.txt" },
    },
  },
  { text: "命令自动放行" },
  {
    tool: {
      name: "run_terminal_command",
      arguments: { command: "rm codexlike-e2e-nonexistent" },
    },
  },
  { text: "危险命令已批准执行" },
  {
    tool: {
      name: "write_file",
      arguments: { path: join(homeDir, "outside.txt"), content: "越界" },
    },
  },
  { text: "越界写入完成" },
  {
    tool: {
      name: "write_file",
      arguments: { path: "deny.txt", content: "不应落盘" },
    },
  },
  { text: "写入被拒绝，我只读" },
];

async function waitReply(window, text) {
  await window
    .getByTestId("message-assistant")
    .filter({ hasText: text })
    .waitFor({ timeout: 20_000 });
  await window.getByTestId("composer-send").waitFor();
}

async function send(window, text) {
  await window.getByTestId("composer-input").fill(text);
  await window.getByTestId("composer-send").click();
}

async function waitMode(window, mode) {
  await window.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="approval-mode-select"]')?.value ===
      expected,
    mode
  );
}

async function waitHistory(window, text) {
  const history = window
    .getByTestId("interaction-history")
    .filter({ hasText: text });
  await history.waitFor();
  assert(
    (await history.locator("button,input,textarea,select").count()) === 0,
    "审批历史必须只读，不能成为第二个操作入口"
  );
}

async function main() {
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-approval-"));
  mkdirSync(join(homeDir, "workspace"));
  const steps = script(homeDir);
  const { server, port, seenBodies } = await startMockProvider(
    (ctx, { index }) => {
      const step = steps[Math.min(index - 1, steps.length - 1)];
      if (step.tool !== undefined)
        ctx.toolCallRound(`call-${index}`, step.tool.name, step.tool.arguments);
      else ctx.textRound(step.text);
    }
  );
  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    let window = first.window;
    await window.getByTestId("settings-open").click();
    const profiles = window.locator("section").filter({
      has: window.getByRole("heading", {
        name: "Provider Profiles",
        exact: true,
      }),
    });
    await profiles
      .getByRole("button", { name: "+ 新建 Profile", exact: true })
      .click();
    const profileForm = window.locator("form");
    await profileForm.getByLabel("名称", { exact: true }).fill("Mock");
    await profileForm
      .getByLabel("baseURL", { exact: true })
      .fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel("API Key", { exact: true }).fill("sk-e2e");
    await profileForm.getByLabel("模型", { exact: true }).fill("mock-model");
    await profileForm
      .getByRole("button", { name: "创建", exact: true })
      .click();
    await profiles.getByText("Mock", { exact: true }).waitFor();
    await window.getByTestId("settings-back").click();
    await window.getByTestId("new-session").click();
    await window.getByTestId("create-session-confirm").click();
    await window.getByTestId("session-item").waitFor();
    const modeSelect = window.getByTestId("approval-mode-select");
    await waitMode(window, "assist");

    await send(window, "跑一条命令");
    await waitReply(window, "命令自动放行");
    assert(
      existsSync(join(homeDir, "workspace", "assist.txt")),
      "assist 下普通命令未自动执行"
    );
    assert(
      (await window.getByTestId("interaction-panel").count()) === 0,
      "普通命令不应弹交互面板"
    );
    assert(
      (await window.getByTestId("interaction-history").count()) === 0,
      "自动放行不能产生审批历史"
    );
    console.log("[e2e] assist 普通命令自动放行");

    await send(window, "删一个不存在的文件");
    const panel = window.getByTestId("interaction-panel");
    await panel.waitFor({ timeout: 20_000 });
    assert(
      (await panel.textContent()).includes("rm codexlike-e2e-nonexistent"),
      "审批面板未显示命令原文"
    );
    await window.getByTestId("session-item").getByText("等待用户").waitFor();
    const approve = panel.getByTestId("approval-approve");
    assert(
      (await approve.textContent()) === "批准本次",
      "审批按钮文案应为批准本次"
    );
    await approve.click();
    await waitReply(window, "危险命令已批准执行");
    await waitHistory(window, "已批准");
    const approvedToolResult = JSON.parse(seenBodies[3]).messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "call-3"
    );
    assert(
      approvedToolResult !== undefined &&
        !JSON.stringify(approvedToolResult).includes("用户拒绝"),
      "批准后命令结果未回填模型"
    );
    console.log("[e2e] assist 危险命令在统一面板批准后执行");

    await send(window, "/status");
    await window
      .getByTestId("message-status")
      .getByText("帮我批准（assist）：文件编辑与联网自动放行，仅危险命令询问")
      .waitFor();

    await modeSelect.selectOption("full-access");
    const dialog = window.getByTestId("full-access-confirm-dialog");
    await dialog.waitFor();
    await dialog.getByTestId("full-access-confirm-cancel").click();
    await dialog.waitFor({ state: "hidden" });
    await waitMode(window, "assist");
    await modeSelect.selectOption("full-access");
    await dialog.waitFor();
    await dialog.getByTestId("full-access-confirm-ok").click();
    await dialog.waitFor({ state: "hidden" });
    await waitMode(window, "full-access");

    const historyCount = await window
      .getByTestId("interaction-history")
      .count();
    await send(window, "写到工作区外面");
    await waitReply(window, "越界写入完成");
    assert(
      existsSync(join(homeDir, "outside.txt")),
      "full-access 下越界写入未成功"
    );
    assert(
      (await window.getByTestId("interaction-panel").count()) === 0,
      "full-access 不应出现待处理交互"
    );
    assert(
      (await window.getByTestId("interaction-history").count()) ===
        historyCount,
      "full-access 不应新增审批历史"
    );
    console.log("[e2e] full-access 风险确认与工作区外写入");

    await closeApp(app);
    const second = await launchApp({ homeDir });
    app = second.app;
    window = second.window;
    await window.getByTestId("session-item").click();
    await waitMode(window, "full-access");
    await waitHistory(window, "已批准");
    console.log("[e2e] 重启恢复审批档位和只读批准历史");

    await window.getByTestId("approval-mode-select").selectOption("ask");
    await waitMode(window, "ask");
    await send(window, "写一个文件试试");
    const denyPanel = window.getByTestId("interaction-panel");
    await denyPanel.waitFor({ timeout: 20_000 });
    const reject = denyPanel.getByTestId("approval-reject");
    assert((await reject.textContent()) === "拒绝", "拒绝按钮文案不正确");
    await reject.click();
    await waitReply(window, "写入被拒绝，我只读");
    await waitHistory(window, "已拒绝");
    assert(
      !existsSync(join(homeDir, "workspace", "deny.txt")),
      "ask 档拒绝后文件不应落盘"
    );
    const rejectedToolResult = JSON.parse(seenBodies[7]).messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "call-7"
    );
    assert(
      JSON.stringify(rejectedToolResult).includes("拒绝"),
      "真实模型请求未携带拒绝结果"
    );
    console.log("[e2e] ask 拒绝不执行，真实工具结果回填模型");
    console.log("[e2e] 审批冒烟通过");
  } finally {
    if (app !== undefined) await closeApp(app);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(homeDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

main().catch((error) => {
  console.error("[e2e] 审批冒烟失败", error);
  process.exitCode = 1;
});
