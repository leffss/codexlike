// E2E 审批冒烟（GLOSSARY「审批模式」新三档，ADR 0004）：真实 Electron 应用走最小路径——
// 新建会话（默认 assist）→ 普通命令自动放行 → 危险命令弹审批卡（点「批准」后真实执行）
// → 切 full-access 先弹风险确认（取消回退 / 确认生效）→ 越界写工作区外文件成功
// → 重启后档位随会话恢复 → 切 ask 后写入弹卡被拒绝、文件不落盘。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:approvals（先全仓 build）。
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, closeApp, launchApp, startMockProvider } from "./helpers.mjs";

/**
 * 场景脚本：按请求序号脚本化（03 踩坑：tool_call 走
 * delta.tool_calls + finish_reason 'tool_calls'；arguments 是 JSON 字符串）。
 * 轮次 = 每次发送消息一轮工具调用 + 一轮收尾文本。
 * 工作区外目标（outside.txt）依赖运行期 mkdtemp 的 homeDir，故为函数。
 */
const script = (homeDir) => [
  // 消息 1：普通命令（assist 非危险 → 自动放行，不应弹卡）
  {
    tool: {
      name: "run_terminal_command",
      arguments: { command: "echo assist-ok > assist.txt" },
    },
  },
  { text: "命令自动放行" },
  // 消息 2：危险命令（rm 首词命中黑名单 → 弹审批卡；目标不存在 → 执行报错，无害）
  {
    tool: {
      name: "run_terminal_command",
      arguments: { command: "rm codexlike-e2e-nonexistent" },
    },
  },
  { text: "危险命令已批准执行" },
  // 消息 3（切 full-access 后）：写入工作区外的本地文件（ADR 0004 边界放开）
  {
    tool: {
      name: "write_file",
      arguments: { path: join(homeDir, "outside.txt"), content: "越界" },
    },
  },
  { text: "越界写入完成" },
  // 消息 4（切 ask 后）：写入弹卡被拒绝，文件不落盘
  {
    tool: {
      name: "write_file",
      arguments: { path: "deny.txt", content: "不应落盘" },
    },
  },
  { text: "写入被拒绝，我只读" },
];

async function main() {
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-approval-"));
  mkdirSync(join(homeDir, "workspace"));
  const SCRIPT = script(homeDir);
  const { server, port } = await startMockProvider((ctx, { index }) => {
    const step = SCRIPT[Math.min(index - 1, SCRIPT.length - 1)];
    if (step.tool !== undefined) {
      ctx.toolCallRound(`call-${index}`, step.tool.name, step.tool.arguments);
      return;
    }
    ctx.textRound(step.text);
  });

  let app;
  try {
    // 1) 启动 → 设置页创建 Profile → 新建会话（默认 assist）
    const first = await launchApp({ homeDir });
    app = first.app;
    let window = first.window;
    await window.getByRole("button", { name: "设置", exact: true }).click();
    await window.getByRole("button", { name: "+ 新建 Profile" }).click();
    const profileForm = window.locator("form");
    await profileForm.getByLabel("名称").fill("Mock");
    await profileForm.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel("API Key").fill("sk-e2e");
    await profileForm.getByLabel("模型").fill("mock-model");
    // 设置页有两个「保存」按钮（Profile 表单与搜索源区，工单 10），限定在表单内点击
    await window
      .locator("form")
      .getByRole("button", { name: /保存|创建/ })
      .click();
    await window.getByText("Mock").first().waitFor();

    await window.getByRole("button", { name: "返回工作台" }).click();
    await window.getByTestId("new-session").click();
    // 新建会话对话框：选运行位置（默认本目录直跑）
    await window.getByTestId("create-session-confirm").click();
    await window
      .getByTestId("session-item")
      .first()
      .waitFor({ timeout: 10_000 });
    console.log("[e2e] 会话已创建（默认 assist 审批模式）");

    // 选择器显示「帮我批准」档（当前会话真实值）
    const modeSelect = window.getByTestId("approval-mode-select");
    assert(
      (await modeSelect.inputValue()) === "assist",
      "审批模式选择器未默认 assist"
    );

    // 2) 消息 1：普通命令自动放行（无审批卡，命令真实执行）
    await window.getByTestId("composer-input").fill("跑一条命令");
    await window.getByTestId("composer-send").click();
    await new Promise((r) => setTimeout(r, 1_500));
    assert(
      existsSync(join(homeDir, "workspace", "assist.txt")),
      "assist 下普通命令未自动执行"
    );
    assert(
      (await window.getByTestId("approval-card").count()) === 0,
      "普通命令不应弹审批卡"
    );
    await window
      .getByTestId("message-assistant")
      .last()
      .getByText("命令自动放行")
      .waitFor({ timeout: 20_000 });
    console.log("[e2e] assist：普通命令自动放行，无审批卡");

    // 3) 消息 2：危险命令弹审批卡片（三键可见、命令原文、侧栏「等待审批」徽标）→ 批准后真实执行
    await window.getByTestId("composer-input").fill("删一个不存在的文件");
    await window.getByTestId("composer-send").click();

    const approvalCard = window.getByTestId("approval-card").first();
    await approvalCard.waitFor({ timeout: 20_000 });
    assert(
      (await approvalCard.getAttribute("data-approval-command")) ===
        "rm codexlike-e2e-nonexistent",
      "审批卡片未显示命令原文"
    );
    await window
      .getByTestId("session-item")
      .first()
      .getByText("等待审批")
      .waitFor({ timeout: 5_000 });
    await approvalCard.getByTestId("approval-approve").click();
    await approvalCard.getByText("已批准").waitFor({ timeout: 10_000 });
    await window
      .getByTestId("message-assistant")
      .last()
      .getByText("危险命令已批准执行")
      .waitFor({ timeout: 20_000 });
    console.log("[e2e] assist：危险命令弹卡，批准后真实执行");

    // 4) /status 显示审批模式真实值
    await window.getByTestId("composer-input").fill("/status");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-status")
      .last()
      .getByText("帮我批准（assist）：文件编辑与联网自动放行，仅危险命令询问")
      .waitFor({ timeout: 10_000 });
    console.log("[e2e] /status 显示审批模式真实值");

    // 5) 切换到 full-access：先弹风险确认（ADR 0004）→ 取消回退 → 再切并确认生效
    await modeSelect.selectOption("full-access");
    const confirmDialog = window.getByTestId("full-access-confirm-dialog");
    await confirmDialog.waitFor({ timeout: 5_000 });
    await confirmDialog.getByTestId("full-access-confirm-cancel").click();
    await new Promise((r) => setTimeout(r, 300));
    assert(
      (await modeSelect.inputValue()) === "assist",
      "取消确认后选择器应回显 assist"
    );
    assert(
      (await window.getByTestId("full-access-confirm-dialog").count()) === 0,
      "取消后确认弹窗应关闭"
    );

    await modeSelect.selectOption("full-access");
    await confirmDialog.waitFor({ timeout: 5_000 });
    await confirmDialog.getByTestId("full-access-confirm-ok").click();
    await new Promise((r) => setTimeout(r, 500));
    assert(
      (await modeSelect.inputValue()) === "full-access",
      "确认后选择器未切到 full-access"
    );
    console.log("[e2e] full-access：风险确认弹窗（取消回退 / 确认生效）");

    // 6) 消息 3：写入工作区外的本地文件成功（边界放开，ADR 0004）
    const cardCountBefore = await window.getByTestId("approval-card").count();
    await window.getByTestId("composer-input").fill("写到工作区外面");
    await window.getByTestId("composer-send").click();
    await new Promise((r) => setTimeout(r, 1_500));
    assert(
      existsSync(join(homeDir, "outside.txt")),
      "full-access 下越界写入未成功"
    );
    // 不新增审批卡（历史卡片转结果态后仍留在 DOM，按计数差断言）
    assert(
      (await window.getByTestId("approval-card").count()) === cardCountBefore,
      "full-access 不应弹新审批卡"
    );
    await window
      .getByTestId("message-assistant")
      .last()
      .getByText("越界写入完成")
      .waitFor({ timeout: 20_000 });
    console.log("[e2e] full-access：越界写工作区外文件成功");

    // 7) 重启（等价应用重启）→ 审批档位随会话记录恢复
    await closeApp(app);
    const second = await launchApp({ homeDir });
    app = second.app;
    window = second.window;
    await window
      .getByTestId("session-item")
      .first()
      .waitFor({ timeout: 15_000 });
    await window.getByTestId("session-item").first().click();
    await window
      .getByTestId("approval-mode-select")
      .waitFor({ timeout: 10_000 });
    assert(
      (await window.getByTestId("approval-mode-select").inputValue()) ===
        "full-access",
      "重启后档位未恢复为 full-access"
    );
    console.log("[e2e] 重启后审批档位随会话恢复");

    // 8) 切换到 ask：写入弹审批卡 → 拒绝 → 文件不落盘、拒绝原因回填模型、循环不崩
    await window.getByTestId("approval-mode-select").selectOption("ask");
    await new Promise((r) => setTimeout(r, 300));
    assert(
      (await window.getByTestId("approval-mode-select").inputValue()) === "ask",
      "选择器未切到 ask"
    );
    await window.getByTestId("composer-input").fill("写一个文件试试");
    await window.getByTestId("composer-send").click();
    const denyCard = window.getByTestId("approval-card").first();
    await denyCard.waitFor({ timeout: 20_000 });
    await denyCard.getByTestId("approval-reject").click();
    await denyCard.getByText("已拒绝").waitFor({ timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 500));
    assert(
      !existsSync(join(homeDir, "workspace", "deny.txt")),
      "ask 档拒绝后文件不应落盘"
    );
    await window
      .getByTestId("message-assistant")
      .last()
      .getByText("写入被拒绝，我只读")
      .waitFor({ timeout: 20_000 });
    console.log("[e2e] ask：写入弹卡被拒，模型收到拒绝原因后正常继续");

    await closeApp(app);
    console.log("[e2e] 审批冒烟通过 ✅");
  } catch (error) {
    console.error("[e2e] 审批冒烟失败 ❌", error);
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
