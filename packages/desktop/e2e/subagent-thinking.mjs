// E2E 思考档位 03：子代理快照继承与折叠展示全链路。
// 路径：双 Profile（主 mock-main / 子代理独立 mock-sub，同一本地 mock 按 model 分流）
// → 设置页把子代理模型指向独立 Profile → 任务选 high 档委派 → 断言：
// 1) 主/子请求 body 都带 high 档字段（独立 Profile 使用 + 档位继承，无静默映射）；
// 2) 子代理运行中把胶囊切到 off：子代理后续轮次（工具回填后的第二轮）仍是 high 快照，
//    下一条新消息才用 off（证明切档真实生效但不影响已触发任务）；
// 3) 子代理第一轮的 reasoning_content 不回传第二轮请求（provider transformParams 剥离）；
// 4) SubagentCard 思考流折叠块：默认收起、展开可见、与报告正文互不混入。
// 运行：pnpm --filter @codexlike/desktop run test:e2e:subagent-thinking（先 pnpm build）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  selectComposerOption,
  assert,
  closeApp,
  collapseSubagentList,
  launchApp,
  openSubagentDetail,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

const DELEGATE_TASK = "E2E子代理思考档位委派任务：读取 note.txt 并总结";
const NOTE_CONTENT = "E2E子代理档位预置文件内容XYZ";
const SUB_REASONING_1 = "子代理第一轮思考标记AAA";
const SUB_REASONING_2 = "子代理第二轮思考标记BBB";
const REPORT_TEXT = "E2E子代理思考档位报告标记CCC：内容已总结。";
/** 主/子请求识别（mock 同一 server，按 body 的 model 字段分流） */
const SUB_MODEL = "mock-sub";

async function main() {
  const { server, port, seenBodies } = await startMockProvider(
    (ctx, { body }) => {
      // JSON.parse 后按 model 字段判断（与他处一致）：子串匹配依赖序列化无空格，脆弱
      const isSub = JSON.parse(body).model === SUB_MODEL;
      if (isSub && !body.includes(NOTE_CONTENT)) {
        // 子代理第一轮：延迟 800ms（给 E2E 留出「运行中切档」窗口），
        // 然后回思考 + read_file 工具调用
        setTimeout(() => {
          ctx.send({
            delta: { reasoning_content: SUB_REASONING_1 },
            finish_reason: null,
          });
          ctx.toolCallRound("call-sub-read", "read_file", { path: "note.txt" });
        }, 800);
        return;
      }
      if (isSub) {
        // 子代理第二轮（note.txt 内容已回填）：思考 + 最终报告
        ctx.send({
          delta: { reasoning_content: SUB_REASONING_2 },
          finish_reason: null,
        });
        ctx.textRound(REPORT_TEXT);
        return;
      }
      // 主任务：含报告标记的轮次（第二轮汇总 + 后续历史轮）→ 汇总文本；
      // 委派指令轮 → spawn_subagent；新档位验证轮 → 文本
      if (body.includes("新档位验证消息")) {
        ctx.textRound("新档位消息已收到");
        return;
      }
      if (body.includes(REPORT_TEXT)) {
        ctx.textRound("子代理报告已汇总。");
        return;
      }
      if (body.includes("委派调研读取笔记")) {
        ctx.toolCallRound("call-delegate", "spawn_subagent", {
          task: DELEGATE_TASK,
        });
        return;
      }
      ctx.res.writeHead(422);
      ctx.res.end("unexpected request");
    }
  );
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-sub-thinking-"));
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);
  writeFileSync(join(workspaceDir, "note.txt"), NOTE_CONTENT);

  let app;
  try {
    const { app: launchedApp, window } = await launchApp({ homeDir });
    app = launchedApp;

    // 1) 设置页：建主 Profile（mock-main）与子代理独立 Profile（mock-sub）
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    let profileForm = window.locator("form");
    await profileForm.getByLabel("名称").fill("Mock");
    await profileForm.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel("API Key").fill("sk-e2e");
    await profileForm.getByLabel("模型").fill("mock-main");
    await profileForm.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Mock").first().waitFor();

    await window.getByTestId("profile-create").click();
    profileForm = window.locator("form");
    await profileForm.getByLabel("名称").fill("MockSub");
    await profileForm.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel("API Key").fill("sk-e2e-sub");
    await profileForm.getByLabel("模型").fill("mock-sub");
    await profileForm.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("MockSub").first().waitFor();

    // 2) 子代理配置区：模型指向独立 Profile MockSub。
    // 配置区在设置页挂载时拉取 Profile 列表——新建的 MockSub 需重进设置页才出现
    await window.getByTestId("settings-back").click();
    await window.getByTestId("settings-open").click();
    await window.getByTestId("subagent-settings").waitFor({ timeout: 10_000 });
    await window
      .getByTestId("subagent-profile-select")
      .selectOption({ label: "MockSub · mock-sub" });
    await window.getByTestId("subagent-settings-save").click();
    await window
      .getByTestId("subagent-settings-message")
      .waitFor({ timeout: 10_000 });
    const saved = await window
      .getByTestId("subagent-settings-message")
      .textContent();
    assert(saved?.includes("已保存") === true, `子代理设置保存失败：${saved}`);
    console.log("[e2e] 子代理独立 Profile（mock-sub）已配置");

    // 3) 建任务 → 选 high 档 → 委派（触发子代理）
    await window.getByTestId("settings-back").click();
    await prepareDraft(window, { approvalMode: "assist" });

    await selectComposerOption(window, "thinking-effort-select", "high");
    await window.getByTestId("composer-input").fill("委派调研读取笔记");
    await window.getByTestId("composer-send").click();

    // 4) 运行中切档：等子代理第一轮请求到达 mock（此刻流挂着，处于运行中）
    for (let tick = 0; tick < 100 && seenBodies.length < 2; tick++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(
      seenBodies.length === 2,
      `预期主+子各 1 个请求，实际 ${seenBodies.length}`
    );
    const subFirst = JSON.parse(seenBodies[1]);
    assert(
      subFirst.model === "mock-sub",
      `第 2 个请求应是子代理（mock-sub），实际 ${subFirst.model}`
    );
    await selectComposerOption(window, "thinking-effort-select", "off");
    console.log("[e2e] 子代理运行中已把档位切到 off（只对下一条消息生效）");

    // 5) 等全部 4 个请求到达（子代理第二轮 + 主任务第二轮）
    for (let tick = 0; tick < 150 && seenBodies.length < 4; tick++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(seenBodies.length === 4, `预期 4 个请求，实际 ${seenBodies.length}`);

    const mainFirst = JSON.parse(seenBodies[0]);
    assert(
      mainFirst.model === "mock-main" &&
        mainFirst.thinking?.type === "enabled" &&
        mainFirst.reasoning_effort === "high",
      `主任务请求应为 mock-main + high 档：${seenBodies[0]}`
    );
    assert(
      subFirst.thinking?.type === "enabled" &&
        subFirst.reasoning_effort === "high",
      `子代理请求应继承 high 档（独立 Profile 不静默改档）：${seenBodies[1]}`
    );
    // 子代理第二轮：运行中切 off 不影响快照；思考不回传；工具结果已回填
    const subSecond = JSON.parse(seenBodies[2]);
    assert(
      subSecond.model === "mock-sub",
      `第 3 个请求应是子代理第二轮，实际 ${subSecond.model}`
    );
    assert(
      subSecond.thinking?.type === "enabled" &&
        subSecond.reasoning_effort === "high",
      `运行中切档不应影响已触发子代理：第二轮应为 high 快照，实际 ${seenBodies[2]}`
    );
    assert(
      !seenBodies[2].includes(SUB_REASONING_1) &&
        !seenBodies[2].includes("reasoning_content"),
      `子代理思考不应回传第二轮请求：${seenBodies[2]}`
    );
    assert(
      seenBodies[2].includes(NOTE_CONTENT),
      "子代理第二轮应含工具结果（note.txt 内容）"
    );
    // 主任务第二轮：报告回流
    assert(
      seenBodies[3].includes(REPORT_TEXT) &&
        seenBodies[3].includes("mock-main"),
      `主任务第二轮应收到子代理报告：${seenBodies[3]}`
    );
    console.log(
      "[e2e] 主/子请求 body：high 档继承、快照不受运行中切档影响、思考不回传"
    );

    // 6) 子代理详情思考折叠块（ADR 0020 右栏）：完成态下默认收起 → 展开 →
    //    与报告互不混入。过程段平铺常驻（ADR 0015），主轮完成后标记行
    //    转完成态，点击打开右栏详情，折叠交互断言本身不变
    await window.getByTestId("composer-send").waitFor({ timeout: 20_000 });
    await window
      .locator(
        '[data-testid="subagent-stream-marker-toggle"][data-subagent-state="done"]'
      )
      .waitFor({ timeout: 20_000 });
    const subagentPanel = await openSubagentDetail(window);
    const thinkingBlock = subagentPanel
      .getByTestId("subagent-thinking-block")
      .first();
    await thinkingBlock.waitFor({ timeout: 10_000 });
    const thinkingContent = thinkingBlock.getByTestId(
      "subagent-thinking-content"
    );
    assert(
      !(await thinkingContent.isVisible()),
      "子代理思考块应默认收起（内容不可见）"
    );
    // focus 定位展开的浮层盖住详情区拦截点击——收起后再展开思考块
    await collapseSubagentList(window);
    await thinkingBlock.getByTestId("subagent-thinking-toggle").click();
    await thinkingContent.waitFor({ timeout: 10_000 });
    const thinkingText = await thinkingContent.textContent();
    assert(
      thinkingText !== null &&
        thinkingText.includes(SUB_REASONING_1) &&
        thinkingText.includes(SUB_REASONING_2) &&
        !thinkingText.includes(REPORT_TEXT),
      `子代理思考内容不完整或混入报告：${thinkingText ?? "(空)"}`
    );
    const reportText = await subagentPanel
      .getByTestId("subagent-report")
      .textContent();
    assert(
      reportText !== null &&
        reportText.includes(REPORT_TEXT) &&
        !reportText.includes(SUB_REASONING_1) &&
        !reportText.includes(SUB_REASONING_2),
      `子代理报告不应混入思考：${reportText ?? "(空)"}`
    );
    // 收起后内容不可见（折叠交互）
    await thinkingBlock.getByTestId("subagent-thinking-toggle").click();
    assert(
      !(await thinkingContent.isVisible()),
      "点击收起后子代理思考内容应不可见"
    );
    console.log("[e2e] 子代理详情思考流：折叠展示、与报告互不混入");

    // 7) 下一条消息采用新档位 off（证明切档真实生效，只是不影响已触发任务）
    await window.getByTestId("composer-input").fill("新档位验证消息");
    await window.getByTestId("composer-send").click();
    for (let tick = 0; tick < 100 && seenBodies.length < 5; tick++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(
      seenBodies.length === 5,
      `预期第 5 个请求，实际 ${seenBodies.length}`
    );
    const nextMessage = JSON.parse(seenBodies[4]);
    assert(
      nextMessage.model === "mock-main" &&
        nextMessage.thinking?.type === "disabled" &&
        nextMessage.reasoning_effort === undefined,
      `下一条消息应采用 off 档（disabled、无 effort）：${seenBodies[4]}`
    );
    console.log("[e2e] 切档对下一条消息生效（off）：全链路验证闭环");

    await closeApp(app);
    console.log("[e2e] 思考档位 03 子代理全链路通过 ✅");
  } catch (error) {
    console.error("[e2e] 思考档位 03 子代理场景失败 ❌", error);
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
