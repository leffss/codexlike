// 规范与技能 E2E：验证真实 Electron 界面与 mock HTTP 请求，而非只检查菜单。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  assert,
  closeApp,
  launchApp,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

const GLOBAL_RULE = "SKILLS_GLOBAL_RULE_91";
const PROJECT_RULE = "SKILLS_PROJECT_RULE_73";
const PROJECT_BODY = "SKILLS_PROJECT_BODY_82";
const GLOBAL_BODY = "SKILLS_SHADOWED_BODY_44";
const REFERENCE_BODY = "SKILLS_REFERENCE_BODY_53";
const RESOURCE_BODY = "SKILLS_TEXT_RESOURCE_64";

function putSkill(root, name, description, body) {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`
  );
  return dir;
}

async function main() {
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-skills-"));
  const workspace = join(homeDir, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(homeDir, "AGENTS.md"), GLOBAL_RULE);
  writeFileSync(join(workspace, "AGENTS.md"), PROJECT_RULE);
  putSkill(homeDir, "review", "全局审查技能", GLOBAL_BODY);
  putSkill(
    join(workspace, ".agents"),
    "review",
    "被应用目录覆盖的技能",
    "SHADOWED_PROJECT_BODY_95"
  );
  const projectSkill = putSkill(
    join(workspace, ".codexlike"),
    "review",
    "项目代码审查",
    PROJECT_BODY
  );
  const referenceDir = putSkill(
    join(homeDir, "compatible-agents"),
    "reference",
    "参考文档查询",
    REFERENCE_BODY
  );
  mkdirSync(join(referenceDir, "references"));
  writeFileSync(join(referenceDir, "references", "guide.md"), RESOURCE_BODY);
  putSkill(join(workspace, ".agents"), "invalid", "无效候选", "正文");
  writeFileSync(
    join(workspace, ".agents", "skills", "invalid", "SKILL.md"),
    "---\nname: invalid\n---\n缺少描述"
  );

  let stage = "discover";
  const { server, port, seenBodies } = await startMockProvider(
    (ctx, { body }) => {
      const request = JSON.parse(body);
      const isSubagent = request.messages.some(
        (message) =>
          message.role === "system" &&
          JSON.stringify(message.content).includes("CodexLike 的子代理")
      );
      if (stage === "approval-state") {
        if (isSubagent) {
          if (!body.includes(REFERENCE_BODY))
            ctx.toolCallRound("load-state", "load_skill", {
              name: "reference",
            });
          else if (
            !request.messages.some(
              (message) =>
                message.role === "tool" &&
                message.tool_call_id === "write-state"
            )
          )
            ctx.toolCallRound("write-state", "write_file", {
              path: "never-written.txt",
              content: "not allowed",
            });
          else ctx.textRound("SUBAGENT_STATE_REPORT");
        } else if (!body.includes("SUBAGENT_STATE_REPORT")) {
          ctx.toolCallRound("delegate-state", "spawn_subagent", {
            task: "加载 reference 后申请写文件以测试审批。",
          });
        } else ctx.textRound("完成:approval-state");
        return;
      }
      if (stage === "auto" || (stage === "delegate" && isSubagent)) {
        if (!body.includes(REFERENCE_BODY)) {
          ctx.toolCallRound(`load-${stage}`, "load_skill", {
            name: "reference",
          });
        } else if (!body.includes(RESOURCE_BODY)) {
          ctx.toolCallRound(`resource-${stage}`, "read_skill_resource", {
            name: "reference",
            path: "references/guide.md",
          });
        } else {
          ctx.textRound(
            isSubagent ? "SUBAGENT_RESOURCE_REPORT" : `完成:${stage}`
          );
        }
        return;
      }
      if (stage === "delegate" && !body.includes("SUBAGENT_RESOURCE_REPORT")) {
        ctx.toolCallRound("delegate-skills", "spawn_subagent", {
          task: "独立查阅 reference 技能及 references/guide.md 后报告。",
        });
        return;
      }
      ctx.textRound(`完成:${stage}`);
    }
  );

  let app;
  try {
    const launched = await launchApp({ homeDir });
    app = launched.app;
    let window = launched.window;
    await window
      .locator("header nav")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await window.getByTestId("profile-create").click();
    const form = window.locator("form");
    await form.getByLabel("名称").fill("Skills Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
    await form.getByLabel("API Key").fill("sk-e2e");
    await form.getByLabel("模型").fill("mock-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Skills Mock", { exact: true }).first().waitFor();
    await window
      .locator("header nav")
      .getByRole("button", { name: "返回工作台", exact: true })
      .click();
    await prepareDraft(window, { approvalMode: "assist" });

    async function send(text, nextStage) {
      stage = nextStage;
      const start = seenBodies.length;
      await window.getByTestId("composer-input").fill(text);
      await window.getByTestId("composer-send").click();
      await window
        .getByTestId("message-assistant")
        .filter({ hasText: `完成:${nextStage}` })
        .waitFor({ timeout: 30_000 });
      await window.getByTestId("composer-send").waitFor();
      return seenBodies.slice(start);
    }

    const discovery = await send("只报告已就绪，不使用技能。", "discover");
    await window.getByTestId("resources-toggle").click();
    const panel = window.getByTestId("resources-panel");
    await panel.waitFor();
    const panelText = await panel.textContent();
    assert(
      panelText.includes("review") && panelText.includes("reference"),
      "两套技能来源未展示"
    );
    assert(panelText.includes("invalid"), "无效技能诊断未展示");
    assert(
      !panelText.includes(PROJECT_BODY) && !panelText.includes(REFERENCE_BODY),
      "列表不得预加载正文"
    );
    await window.getByTestId("resources-toggle").click();

    assert(discovery.length === 1, "未使用技能时应只有首次模型请求");
    assert(
      discovery[0].includes(GLOBAL_RULE) && discovery[0].includes(PROJECT_RULE),
      "规范未进入请求"
    );
    assert(
      discovery[0].includes("项目代码审查") &&
        discovery[0].includes("参考文档查询"),
      "技能索引未进入请求"
    );
    assert(
      !discovery[0].includes(PROJECT_BODY) &&
        !discovery[0].includes(GLOBAL_BODY) &&
        !discovery[0].includes(REFERENCE_BODY),
      "未加载的正文泄漏到请求"
    );

    // 菜单选择仅写回引用，再添加第二个引用并显式发送。
    await window.getByTestId("composer-input").fill("$rev");
    await window.getByTestId("composer-menu").waitFor();
    assert(
      (await window.getByTestId("composer-menu").textContent()).includes(
        "review"
      ),
      "$菜单没有技能候选"
    );
    const beforeSelection = seenBodies.length;
    await window.getByTestId("composer-input").press("Enter");
    assert(
      (await window.getByTestId("composer-input").inputValue()).includes(
        "$review"
      ),
      "选择没有回填技能引用"
    );
    assert(seenBodies.length === beforeSelection, "选择技能不能立即发送消息");
    await window.getByTestId("composer-input").fill("请使用 $ref");
    await window.getByTestId("composer-skill-reference").waitFor();
    await window.getByTestId("composer-input").press("Tab");
    assert(
      (await window.getByTestId("composer-input").inputValue()).includes(
        "$reference"
      ),
      "Tab 未回填技能"
    );
    await window.getByTestId("composer-input").fill("$rev");
    const reviewOption = window.getByTestId("composer-skill-review");
    await reviewOption.waitFor();
    assert(
      (await reviewOption.textContent()).includes("项目"),
      "技能候选未显示项目来源"
    );
    await reviewOption.click();
    assert(
      (await window.getByTestId("composer-input").inputValue()).includes(
        "$review"
      ),
      "鼠标未回填技能"
    );
    assert(seenBodies.length === beforeSelection, "Tab/鼠标选择不能立即发送");
    const explicit = await send(
      "$review $reference 按两项技能完成任务。",
      "explicit"
    );
    assert(
      explicit[0].includes(PROJECT_BODY) &&
        explicit[0].includes(REFERENCE_BODY),
      "显式多技能没有在首次请求前加载"
    );
    assert(
      !explicit[0].includes(GLOBAL_BODY) &&
        !explicit[0].includes("SHADOWED_PROJECT_BODY_95"),
      "同名覆盖未遵循项目及目录优先级"
    );

    const cleared = await send("现在执行一个不需要技能的新任务。", "clear");
    assert(
      !cleared[0].includes(PROJECT_BODY) &&
        !cleared[0].includes(REFERENCE_BODY),
      "上一条消息的技能正文未释放"
    );

    const automatic = await send(
      "请自主选择参考技能并读取其中的 guide.md。",
      "auto"
    );
    assert(
      automatic.length === 3,
      "自主加载应有加载正文、读取资源、完成三个模型请求"
    );
    assert(!automatic[0].includes(REFERENCE_BODY), "自主选择前不应加载正文");
    assert(automatic[1].includes(REFERENCE_BODY), "load_skill 结果未回填");
    assert(automatic[2].includes(RESOURCE_BODY), "全局技能附属文本未回填");

    const delegated = await send(
      "$review 将参考文档查询交给子代理。",
      "delegate"
    );
    const subagentRequests = delegated.filter((body) =>
      JSON.parse(body).messages.some(
        (message) =>
          message.role === "system" &&
          JSON.stringify(message.content).includes("CodexLike 的子代理")
      )
    );
    assert(subagentRequests.length === 3, "子代理未独立加载技能和资源");
    assert(
      subagentRequests[0].includes(GLOBAL_RULE) &&
        subagentRequests[0].includes(PROJECT_RULE),
      "子代理未继承规范"
    );
    assert(
      !subagentRequests[0].includes(PROJECT_BODY) &&
        !subagentRequests[0].includes(REFERENCE_BODY),
      "子代理继承了主会话已加载正文"
    );
    assert(
      subagentRequests[2].includes(RESOURCE_BODY),
      "子代理独立资源读取失败"
    );

    await window.getByTestId("resources-toggle").click();
    await panel.waitFor();
    const loadedText = await panel.textContent();
    assert(
      loadedText.includes("review") &&
        loadedText.includes("reference") &&
        loadedText.includes("最近"),
      "最近加载记录未展示"
    );
    await window.getByTestId("resources-toggle").click();

    writeFileSync(join(workspace, "AGENTS.md"), "UPDATED_PROJECT_RULE_15");
    writeFileSync(
      join(projectSkill, "SKILL.md"),
      "---\nname: review\ndescription: 更新后的项目技能\n---\nUPDATED_PROJECT_BODY_27"
    );
    const changed = await send("$review 使用刚更新的规范。", "changed");
    assert(
      changed[0].includes("UPDATED_PROJECT_RULE_15") &&
        !changed[0].includes(PROJECT_RULE),
      "缓存会话未刷新 AGENTS"
    );
    assert(
      changed[0].includes("UPDATED_PROJECT_BODY_27") &&
        !changed[0].includes(PROJECT_BODY),
      "缓存会话未刷新技能"
    );

    // 不存在的显式技能不能发出模型请求。
    const beforeUnknown = seenBodies.length;
    await window.getByTestId("composer-input").fill("$does-not-exist 不能发送");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-error")
      .last()
      .waitFor({ timeout: 10_000 });
    assert(seenBodies.length === beforeUnknown, "未知显式技能仍向模型发送请求");

    await window.getByTestId("approval-mode-select").selectOption("ask");
    await window.getByTestId("resources-toggle").click();
    stage = "approval-state";
    await window
      .getByTestId("composer-input")
      .fill("委派子代理测试加载后审批状态。");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("approval-reject").waitFor({ timeout: 30_000 });
    const activeSection = panel.locator("section").filter({
      has: window.getByRole("heading", {
        name: "当前运行快照（active）",
        exact: true,
      }),
    });
    await activeSection.getByText(/^执行者 /).waitFor({ timeout: 10_000 });
    assert(
      (await activeSection.textContent()).includes("reference"),
      "子代理等待审批时当前快照没有刷新已加载记录"
    );
    await window.getByTestId("approval-reject").click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "完成:approval-state" })
      .waitFor({ timeout: 30_000 });
    await window.getByTestId("resources-toggle").click();
    await window.getByTestId("composer-input").fill("/status");
    await window.getByTestId("composer-input").press("Enter");
    const statusAfterLoad = window.getByTestId("message-status").last();
    await statusAfterLoad.waitFor();
    assert(
      (await statusAfterLoad.textContent()).includes("reference") &&
        (await statusAfterLoad.textContent()).includes("最近"),
      "/status 缺少最近一轮子代理加载摘要"
    );

    const indented = await send("    echo $path", "indented-code");
    assert(indented.length === 1, "缩进代码中的变量不应触发技能加载");
    assert(
      !indented[0].includes(REFERENCE_BODY) &&
        !indented[0].includes("UPDATED_PROJECT_BODY_27"),
      "缩进代码错误激活技能正文"
    );
    await send("请解释下面的代码：\n\n    echo $path", "indented-block");

    await closeApp(app);
    const relaunched = await launchApp({ homeDir });
    app = relaunched.app;
    window = relaunched.window;
    await window.getByTestId("session-item").first().waitFor();
    const restored = await send("恢复后的普通消息，不使用技能。", "restored");
    assert(
      !restored[0].includes("UPDATED_PROJECT_BODY_27") &&
        !restored[0].includes(REFERENCE_BODY),
      "恢复会话重新激活了旧技能正文"
    );
    console.log(
      "[e2e] 规范刷新、目录覆盖、$多技能、按需加载、附属资源、子代理隔离与恢复通过"
    );
  } catch (error) {
    console.error("[e2e] 规范与技能失败", error);
    process.exitCode = 1;
  } finally {
    if (app !== undefined) await closeApp(app);
    await new Promise((resolve) => server.close(resolve));
    rmSync(homeDir, { recursive: true, force: true });
  }
}

await main();
