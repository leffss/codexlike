// README 截图生成（一次性文档工具，可重复运行）：
// 复用 e2e 设施（隔离 CODEXLIKE_HOME + OpenAI 兼容 mock + 真实 Electron
// 生产产物），按剧本造一组覆盖各功能面的任务，逐界面截图到 docs/img/。
// 与 e2e 场景的差异：只摆拍不断言——每张图等待目标元素可见即截，验证
// 交给人工走查（README 图是给人看的）。
// 运行（先 pnpm build 保证 dist 新鲜）：node scripts/readme-screenshots.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  closeApp,
  launchApp,
  openRailPanel,
  openSubagentDetail,
  selectComposerOption,
  startMockProvider,
} from "../e2e/helpers.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const OUT_DIR = join(REPO_ROOT, "docs", "img");
const WINDOW_SIZE = [1440, 900];

/** 剧本各任务的首句（= 任务标题，mock 分流判据） */
const TOPIC = {
  read: "梳理项目结构",
  write: "添加配置文件",
  question: "确认部署方向",
  delegate: "委派调研测试入口",
  longrun: "后台长任务演示",
};
const SUBAGENT_SYSTEM_MARK = "CodexLike 的子代理";
const REPORT_MARK = "子代理报告：入口集中在 packages/desktop/e2e。";

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** 造 git 项目目录：初始提交 + 未提交改动（改动面板 diff 素材） */
function prepareProjectDir(dir) {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "README.md"),
    "# 项目 Demo\n\n用于 README 截图的示例项目。\n\n- `src/app.ts`：入口\n- `src/utils.ts`：工具函数\n"
  );
  writeFileSync(
    join(dir, "src", "app.ts"),
    [
      'import { formatTime } from "./utils";',
      "",
      "export function main() {",
      "  console.log(formatTime(new Date()));",
      "}",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(dir, "src", "utils.ts"),
    [
      "/** 本地时间格式化（示例改动前的版本） */",
      "export function formatTime(date: Date) {",
      "  return date.toISOString();",
      "}",
      "",
    ].join("\n")
  );
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-b", "main");
  git("add", ".");
  git(
    "-c",
    "user.email=demo@codexlike.local",
    "-c",
    "user.name=demo",
    "commit",
    "-m",
    "初始提交"
  );
  // 未提交改动：utils.ts 换实现（diff 可见；行宽控制在右栏 diff 不截断）
  writeFileSync(
    join(dir, "src", "utils.ts"),
    [
      "/** 本地时间格式化（改为本地时区） */",
      "export function formatTime(date: Date) {",
      '  return date.toLocaleString("zh-CN");',
      "}",
      "",
    ].join("\n")
  );
}

async function untilVisible(locator, message, timeout = 20_000) {
  await locator.waitFor({ state: "visible", timeout });
  void message;
}

/** 截图：目标可见后额外静置，等动画/懒加载（Monaco 等）收尾 */
async function shot(window, name, locator, settle = 400) {
  if (locator !== undefined) await untilVisible(locator, name);
  await delay(settle);
  await window.screenshot({ path: join(OUT_DIR, `${name}.png`) });
  console.log(`[shot] ${name}.png`);
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-shots-"));
  const projectDir = join(root, "项目demo");
  prepareProjectDir(projectDir);
  mkdirSync(OUT_DIR, { recursive: true });

  // —— mock 分流（gate 模式：长任务 hold 住不收尾） ——
  /** 首句 → 被 hold 的 ctx（截图后统一释放） */
  const gates = new Map();
  const model = await startMockProvider((ctx, { body }) => {
    const request = JSON.parse(body);
    const text =
      request.messages
        .filter((m) => m.role === "user")
        .map(messageText)
        .at(-1) ?? "";
    const toolText = request.messages
      .filter((m) => m.role === "tool")
      .map(messageText)
      .join("\n");
    const isSubagent = request.messages
      .filter((m) => m.role === "system")
      .map(messageText)
      .join("\n")
      .includes(SUBAGENT_SYSTEM_MARK);
    if (isSubagent) {
      ctx.textChunksRound(
        ["正在扫描 e2e 目录…", "入口脚本共 46 个。", REPORT_MARK, "调研完毕。"],
        40
      );
    } else if (text === TOPIC.read && toolText.includes("formatTime")) {
      ctx.textRound(
        [
          "## 项目结构",
          "",
          "`README.md` 是项目说明，包含两个源文件：",
          "",
          "1. `src/app.ts` — 入口，调用 `formatTime`",
          "2. `src/utils.ts` — 工具函数",
          "",
          "```ts",
          "console.log(formatTime(new Date()));",
          "```",
          "",
          "建议下一步为 `formatTime` 补充时区测试。",
        ].join("\n")
      );
    } else if (text === TOPIC.read && toolText.includes("项目 Demo")) {
      ctx.toolCallRound("call-read-2", "read_file", { path: "src/app.ts" });
    } else if (text === TOPIC.write && toolText.includes("settings.json")) {
      ctx.textRound(
        "已写入 `config/settings.json`，改动可在右侧「改动」面板查看 diff。"
      );
    } else if (text === TOPIC.delegate && toolText.includes(REPORT_MARK)) {
      ctx.textRound(`委派完成。${REPORT_MARK}主流程可直接复用。`);
    } else if (text === TOPIC.longrun) {
      gates.set(TOPIC.longrun, ctx);
      ctx.send({
        delta: {
          content:
            "长任务进行中，正在逐项核对场景清单：\n\n1. 登录链路 — 已核对\n2. 输入队列 — 已核对\n3. 任务恢复 — 进行中，正在比对重启前后的现场…",
        },
        finish_reason: null,
      });
    } else if (text === TOPIC.read) {
      ctx.toolCallRound("call-read-1", "read_file", { path: "README.md" });
    } else if (text === TOPIC.write) {
      ctx.toolCallRound("call-write-1", "write_file", {
        path: "config/settings.json",
        content: '{\n  "theme": "light",\n  "language": "zh-CN"\n}\n',
      });
    } else if (text === TOPIC.question) {
      ctx.toolCallRound("call-ask-1", "ask_user_question", {
        questions: [
          {
            id: "env",
            header: "部署环境",
            question: "这次要部署到哪个环境？",
            multiSelect: false,
            options: [
              { id: "prod", label: "生产环境" },
              { id: "staging", label: "预发环境" },
            ],
          },
          {
            id: "steps",
            header: "上线步骤",
            question: "希望包含哪些上线步骤？（可多选）",
            multiSelect: true,
            options: [
              { id: "backup", label: "先备份数据" },
              { id: "notify", label: "发送变更公告" },
            ],
          },
        ],
      });
    } else if (text === TOPIC.delegate) {
      ctx.toolCallRound("call-delegate-1", "spawn_subagent", {
        task: "调研 packages/desktop/e2e 下测试入口的组织方式",
      });
    } else {
      ctx.textRound("收到。");
    }
  });

  let app;
  try {
    const launched = await launchApp({
      homeDir: join(root, "home"),
      workspaceDir: projectDir,
    });
    app = launched.app;
    const window = launched.window;
    await app.evaluate(({ BrowserWindow }, [w, h]) => {
      BrowserWindow.getAllWindows()[0].setContentSize(w, h);
    }, WINDOW_SIZE);

    // 建 Profile（同 live-tasks 场景的表单路径）
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const form = window.locator("form");
    await form.getByLabel("名称", { exact: true }).fill("GLM");
    await form
      .getByLabel("baseURL", { exact: true })
      .fill(`http://127.0.0.1:${model.port}/v1`);
    await form.getByLabel("API Key", { exact: true }).fill("sk-demo");
    await form.getByLabel("模型 1", { exact: true }).fill("glm-4.7");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("GLM", { exact: true }).first().waitFor();
    await window.getByTestId("settings-back").click();

    // —— 项目 + 任务A（消息流 / 工具卡） ——
    await window.getByTestId("add-project").click();
    await window.getByTestId("project-group").waitFor();
    await window.getByTestId("project-header").hover();
    await window.getByTestId("project-new-task").click();
    await window.getByTestId("composer-input").fill(TOPIC.read);
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "项目结构" })
      .waitFor();
    await window.getByTestId("tool-call-group-toggle").first().click();
    await delay(300);
    await shot(window, "02-message-stream");

    // —— 任务B（写入审批 → 改动面板 diff） ——
    await window.getByTestId("project-header").hover();
    await window.getByTestId("project-new-task").click();
    await window.getByTestId("composer-input").fill(TOPIC.write);
    await window.getByTestId("composer-send").click();
    await window.getByTestId("interaction-panel").waitFor();
    await shot(window, "03-approval-card");
    await window.getByTestId("approval-approve").click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "改动可在右侧" })
      .waitFor();
    await openRailPanel(window, "changes");
    const changesPanel = window.getByTestId("changes-panel");
    // 未提交改动两个文件：点 utils.ts（修改，双栏 diff 两侧都有内容）
    const changedFile = changesPanel
      .getByTestId("changes-file-item")
      .filter({ hasText: "utils.ts" });
    await changedFile.waitFor({ timeout: 10_000 });
    await changedFile.click();
    await changesPanel
      .getByTestId("changes-diff-path")
      .waitFor({ timeout: 10_000 });
    await changesPanel
      .locator(".editor.modified .view-lines")
      .first()
      .waitFor({ timeout: 30_000 });
    await shot(window, "05-rail-changes", undefined, 600);

    // —— 独立任务C（对话内问答，保持等待态） ——
    await window.getByTestId("new-task").click();
    await window.getByTestId("composer-input").fill(TOPIC.question);
    await window.getByTestId("composer-send").click();
    await window.getByTestId("interaction-panel").waitFor();
    await shot(window, "04-ask-user-question");

    // —— 独立任务D（子代理委派：嵌套卡片 + 右栏详情；assist 免子代理
    //    内部工具的连环审批，与 subagents e2e 场景同口径） ——
    await window.getByTestId("new-task").click();
    await selectComposerOption(window, "approval-mode-select", "assist");
    await window.getByTestId("composer-input").fill(TOPIC.delegate);
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "委派完成" })
      .waitFor({ timeout: 20_000 });
    await openSubagentDetail(window);
    await shot(
      window,
      "06-subagent-rail",
      window.getByTestId("subagents-panel-body")
    );
    await window.keyboard.press("Escape");

    // —— 独立任务E（运行中：正文流式 + 侧栏活动徽章） ——
    await window.getByTestId("new-task").click();
    await window.getByTestId("composer-input").fill(TOPIC.longrun);
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "场景清单" })
      .waitFor();

    // —— 侧栏全景（项目组 + 独立组 + 运行中/等待徽章） ——
    await shot(window, "07-task-sidebar", window.getByTestId("task-list"));

    // —— @ 文件引用菜单（切回项目任务A 的工作区） ——
    const taskA = window
      .getByTestId("task-item")
      .filter({ hasText: TOPIC.read });
    await taskA.click();
    await window.getByTestId("composer-input").fill("@");
    await shot(
      window,
      "08-composer-at-menu",
      window.getByTestId("composer-menu")
    );
    await window.keyboard.press("Escape");

    // —— 新建任务起始页（最后截：草稿态干净） ——
    await window.getByTestId("new-task").click();
    await shot(
      window,
      "01-new-task-start",
      window.getByTestId("draft-select-workspace")
    );

    // —— 设置页 ——
    await window.getByTestId("settings-open").click();
    await shot(window, "09-settings", window.getByTestId("profile-create"));
    await window
      .getByTestId("settings-back")
      .click()
      .catch(() => {});

    // 释放 hold 的长任务，让退出无确认弹窗
    gates.get(TOPIC.longrun)?.finishWith("stop");
    await delay(500);
  } finally {
    await closeApp(app).catch(() => {});
    await new Promise((resolveClose) => model.server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`[done] 截图已输出到 ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
