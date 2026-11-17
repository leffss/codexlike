// 规范与技能 E2E：验证真实 Electron 界面与 mock HTTP 请求，而非只检查菜单。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  selectComposerOption,
  assert,
  closeApp,
  closeRailPanel,
  launchApp,
  openRailPanel,
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
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const form = window.locator("form");
    await form.getByLabel("名称").fill("Skills Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
    await form.getByLabel("API Key").fill("sk-e2e");
    await form.getByLabel("模型 1").fill("mock-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Skills Mock", { exact: true }).first().waitFor();
    await window.getByTestId("settings-back").click();
    // 项目会话草稿形态：项目路径在项目记录上、发送前不落 draft，预览须按
    // 项目记录解析（项目目录即 fixture workspace，含全部技能 fixture）。
    await prepareDraft(window, { project: true, approvalMode: "assist" });
    await window.getByTestId("composer-input").fill("$rev");
    await window.getByTestId("composer-menu").waitFor({ timeout: 5_000 });
    const projectDraftMenu = await window
      .getByTestId("composer-menu")
      .textContent();
    assert(
      projectDraftMenu.includes("review") &&
        projectDraftMenu.includes("项目代码审查"),
      "项目会话 draft 态输入框技能菜单没有列出真实存在的技能"
    );
    await window.getByTestId("composer-input").fill("");
    // 右栏「规范与技能」tab 默认「下轮预览」档：draft 预览目录即此档
    await openRailPanel(window, "resources");
    const projectDraftPanel = window.getByTestId("resources-panel");
    await projectDraftPanel.waitFor({ timeout: 5_000 });
    const projectDraftPanelText = await projectDraftPanel.textContent();
    assert(
      projectDraftPanelText.includes("review") &&
        projectDraftPanelText.includes("reference"),
      "项目会话 draft 态规范与技能面板没有预览目录"
    );
    await closeRailPanel(window);

    await prepareDraft(window, { approvalMode: "assist" });

    // draft 态（首条消息发出前）技能必须可用：菜单与面板都来自真实磁盘技能。
    await window.getByTestId("composer-input").fill("$rev");
    await window.getByTestId("composer-menu").waitFor({ timeout: 5_000 });
    const draftMenu = await window.getByTestId("composer-menu").textContent();
    assert(
      draftMenu.includes("review") && draftMenu.includes("项目代码审查"),
      "draft 态输入框技能菜单没有列出真实存在的技能"
    );
    await window.getByTestId("composer-input").fill("");
    await openRailPanel(window, "resources");
    const draftPanel = window.getByTestId("resources-panel");
    await draftPanel.waitFor({ timeout: 5_000 });
    const draftPanelText = await draftPanel.textContent();
    assert(
      draftPanelText.includes("review") && draftPanelText.includes("reference"),
      "draft 态规范与技能面板没有预览目录"
    );
    await closeRailPanel(window);

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
    await openRailPanel(window, "resources");
    const panel = window.getByTestId("resources-panel");
    await panel.waitFor();
    const panelText = await panel.textContent();
    assert(
      panelText.includes("review") && panelText.includes("reference"),
      "两套技能来源未展示"
    );
    // 无效技能：状态文案「无效」（旧面板的英文括注 (invalid) 已随
    // 三卡片结构移除，密排摘要只出中文状态）
    assert(panelText.includes("无效"), "无效技能状态未展示");
    assert(
      !panelText.includes(PROJECT_BODY) && !panelText.includes(REFERENCE_BODY),
      "列表不得预加载正文"
    );
    await closeRailPanel(window);

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
      "子代理继承了主任务已加载正文"
    );
    assert(
      subagentRequests[2].includes(RESOURCE_BODY),
      "子代理独立资源读取失败"
    );

    // 已加载记录在「上轮」档（last 快照）：子代理已结束，无进行中快照，
    // 其加载记录落在最近一轮（旧面板断言的「最近」即「最近一轮摘要」标题）
    await openRailPanel(window, "resources");
    await window.getByTestId("snapshot-tab-last").click();
    await panel.waitFor();
    const loadedText = await panel.textContent();
    assert(
      loadedText.includes("review") && loadedText.includes("reference"),
      "上轮快照未列出两套技能来源"
    );
    assert(
      loadedText.includes("已加载") &&
        (loadedText.match(/main|subagent/g) ?? []).length > 0,
      "最近加载记录未展示（上轮档已加载分区）"
    );
    await closeRailPanel(window);

    writeFileSync(join(workspace, "AGENTS.md"), "UPDATED_PROJECT_RULE_15");
    writeFileSync(
      join(projectSkill, "SKILL.md"),
      "---\nname: review\ndescription: 更新后的项目技能\n---\nUPDATED_PROJECT_BODY_27"
    );
    const changed = await send("$review 使用刚更新的规范。", "changed");
    assert(
      changed[0].includes("UPDATED_PROJECT_RULE_15") &&
        !changed[0].includes(PROJECT_RULE),
      "缓存任务未刷新 AGENTS"
    );
    assert(
      changed[0].includes("UPDATED_PROJECT_BODY_27") &&
        !changed[0].includes(PROJECT_BODY),
      "缓存任务未刷新技能"
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

    await selectComposerOption(window, "approval-mode-select", "ask");
    // 右栏开着走完审批流：本轮档（active 快照）实时刷新已加载记录
    await openRailPanel(window, "resources");
    await window.getByTestId("snapshot-tab-active").click();
    stage = "approval-state";
    await window
      .getByTestId("composer-input")
      .fill("委派子代理测试加载后审批状态。");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("approval-reject").waitFor({ timeout: 30_000 });
    const activePanel = window.getByTestId("resources-panel");
    await activePanel
      .getByText(/reference/)
      .first()
      .waitFor({ timeout: 10_000 });
    assert(
      (await activePanel.textContent()).includes("已加载"),
      "子代理等待审批时本轮快照没有刷新已加载记录"
    );
    await window.getByTestId("approval-reject").click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "完成:approval-state" })
      .waitFor({ timeout: 30_000 });
    await closeRailPanel(window);
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
    await window.getByTestId("task-item").first().waitFor();
    const restored = await send("恢复后的普通消息，不使用技能。", "restored");
    assert(
      !restored[0].includes("UPDATED_PROJECT_BODY_27") &&
        !restored[0].includes(REFERENCE_BODY),
      "恢复任务重新激活了旧技能正文"
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
