// E2E（启动现场恢复，票03）：工作台目标与视图的保存与恢复。
// 全场景真实 UI 操作驱动（mock provider 先例：input-queue-restart / sidebar-archive），
// 每场景独立 homeDir；重启 = closeApp（正常退出屏障）或 taskkill（强杀）后同目录再启动。
// ① 切换到某任务后退出重开，直接回到该任务（非「排序最前的未归档」——侧栏
//    顺序证明打开来源是启动现场，不是现有回退链）
// ② 退出前查看的是归档任务 → 重开照常回到该归档任务
// ③ 退出前停在新建草稿（含项目关联）→ 重开回到同样草稿状态（草稿文本随
//    workbench_state 既有机制恢复）
// ④ 退出前停在设置页 → 重开仍在设置页；返回工作区仍显示最后打开的任务
//    （目标与视图两字段独立）
// ⑤ 记住的任务已不存在 → 回退排序最前的未归档任务；无可打开任务时停新建草稿入口
// ⑥ kill 进程（taskkill /T /F，不走退出屏障）后重开，现场照样恢复
// ⑦ 删除现场文件 → 冷启动行为与现状一致（打开排序最前的未归档任务，非记住的任务）
// ⑧ 运行中切到乙后设置页往返（同一实例内卸载重挂 WorkspacePage）→ 仍显示乙、
//    现场目标仍是乙、再重启仍回乙（重挂不是冷启动，恢复与上报只属真冷启动）
// 运行：node e2e/launch-state-target.mjs（需先 build）。
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";

import {
  assert,
  closeApp,
  launchApp,
  projectAction,
  taskMenu,
  startMockProvider,
  untilDraft,
} from "./helpers.mjs";

const STATE_FILE = "launch-state.json";

async function until(predicate, message, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    assert(Date.now() < end, message);
    await delay(50);
  }
}

function readState(homeDir) {
  return JSON.parse(readFileSync(join(homeDir, STATE_FILE), "utf8"));
}

/** 现场文件尚不存在（首次上报落盘前）按未到达处理，轮询重试 */
function readStateSafe(homeDir) {
  try {
    return readState(homeDir);
  } catch {
    return null;
  }
}

/** 等启动现场文件的工作台目标到达期望（上报为即时落盘，此处只是排掉 IPC 往返） */
async function waitForTarget(homeDir, expected, message) {
  const key = expected.kind === "task" ? "taskId" : "projectId";
  await until(() => {
    const state = readStateSafe(homeDir);
    return (
      state?.workbenchTarget?.kind === expected.kind &&
      state.workbenchTarget[key] === expected[key]
    );
  }, `${message}：launch-state.json 未记录期望的工作台目标`);
}

async function waitForView(homeDir, view, message) {
  await until(
    () => readStateSafe(homeDir)?.view === view,
    `${message}：launch-state.json 的 view 未到达 ${view}`
  );
}

/** 当前打开的任务 id（侧栏选中行）；无打开任务返回 null（evaluateAll 不等待元素） */
async function currentSessionId(window) {
  return window
    .getByTestId("task-row")
    .locator('[aria-current="page"]')
    .evaluateAll((nodes) => nodes[0]?.getAttribute("data-task-id") ?? null);
}

async function assertCurrentSession(window, sessionId, message) {
  await until(
    async () => (await currentSessionId(window)) === sessionId,
    `${message}：应打开任务 ${sessionId}（实际 ${await currentSessionId(window)}）`
  );
}

/** 无打开任务（草稿态或新建入口），composer 输入框在场 */
async function assertNoOpenSession(window, message) {
  await until(async () => (await currentSessionId(window)) === null, message);
  await window.getByTestId("composer-input").waitFor();
}

/** 「无可打开任务」的现有冷启动终态：不自动打开任务，停在新建草稿入口 */
async function assertIdleNewSessionEntry(window, message) {
  await until(
    async () =>
      (await currentSessionId(window)) === null &&
      (await window
        .getByTestId("composer-input")
        .getAttribute("placeholder")) === "新建或选择一个任务后开始对话",
    message
  );
}

/** 排序最前的未归档任务（现有冷启动回退链的打开目标） */
async function firstActiveSessionId(window) {
  return window.evaluate(async () => {
    const list = await window.codexlike.sessions.list();
    return list.find((session) => session.archivedAt === null)?.id ?? null;
  });
}

async function sessionIdByTitle(window, title) {
  const id = await window.evaluate(async (title) => {
    const list = await window.codexlike.sessions.list();
    return list.find((session) => session.title === title)?.id ?? null;
  }, title);
  assert(id !== null, `找不到标题为「${title}」的任务`);
  return id;
}

/** 设置页创建指向本地 mock 的 Provider Profile（先例：input-queue-restart） */
async function createProfile(window, port) {
  await window.getByTestId("settings-open").click();
  await window.getByTestId("profile-create").click();
  const form = window.locator("form");
  await form.getByLabel("名称").fill("Launch Mock");
  await form.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
  await form.getByLabel("API Key").fill("sk-e2e");
  await form.getByLabel("模型").fill("mock-model");
  await form.getByRole("button", { name: /保存|创建/ }).click();
  await window.getByText("Launch Mock", { exact: true }).waitFor();
  await window.getByTestId("settings-back").click();
}

/** 独立新建草稿发送首条消息建立任务（标题=首条消息） */
async function createSession(window, title) {
  await window.getByTestId("new-task").click();
  await window.getByTestId("draft-select-workspace").click();
  await window.getByTestId("composer-input").fill(title);
  await window.getByTestId("composer-send").click();
  await window
    .getByTestId("message-assistant")
    .getByText(`答复：${title}`, { exact: true })
    .waitFor({ timeout: 15_000 });
  await window.getByTestId("composer-send").waitFor();
}

async function selectSession(window, title) {
  await window.getByTestId("task-item").filter({ hasText: title }).click();
}

/** 强杀进程树（Windows taskkill /T /F，先例 exit-recovery），不走退出屏障 */
async function killApp(app) {
  const child = app.process();
  const done = new Promise((resolve) => child.once("exit", () => resolve()));
  if (process.platform === "win32") {
    await new Promise((resolve) =>
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () =>
        resolve()
      )
    );
  } else {
    child.kill("SIGKILL");
  }
  await Promise.race([done, delay(5000)]);
}

/** 单场景骨架：独立 homeDir；结束时清理（Windows 退出后短暂持有句柄，尽力删） */
async function scenario(name, run) {
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-launch-target-"));
  mkdirSync(join(homeDir, "workspace"));
  let app = null;
  try {
    await run(homeDir, {
      launch: async () => {
        const started = await launchApp({ homeDir });
        app = started.app;
        return started;
      },
      relaunch: async () => {
        app = null;
        const started = await launchApp({ homeDir });
        app = started.app;
        return started;
      },
      quit: async () => {
        await closeApp(app);
        app = null;
      },
      kill: async () => {
        await killApp(app);
        app = null;
      },
    });
    console.log(`[e2e] 启动现场目标 ${name}：OK`);
  } finally {
    if (app) await closeApp(app).catch(() => {});
    try {
      rmSync(homeDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    } catch {
      console.warn(`[e2e] 临时目录清理失败（不影响结果）：${homeDir}`);
    }
  }
}

async function main() {
  const { server, port } = await startMockProvider((ctx, { body }) => {
    const text =
      JSON.parse(body)
        .messages.filter((m) => m.role === "user")
        .at(-1)?.content ?? "";
    ctx.textRound(`答复：${text}`);
  });

  try {
    await runScenarios(port);
  } finally {
    server.closeAllConnections();
    server.close();
  }
  console.log(
    "[e2e] 启动现场目标与视图：任务/归档/草稿/设置页/回退/强杀/无文件/设置页往返 全场景 OK"
  );
}

async function runScenarios(port) {
  await scenario("① 切换任务后重开回到该任务", async (homeDir, ctl) => {
    const { window } = await ctl.launch();
    await window.evaluate(() => localStorage.clear());
    await createProfile(window, port);
    await createSession(window, "甲较早任务");
    await createSession(window, "乙最新任务");
    const remembered = await sessionIdByTitle(window, "甲较早任务");
    const front = await sessionIdByTitle(window, "乙最新任务");
    await selectSession(window, "甲较早任务");
    await assertCurrentSession(window, remembered, "退出前应查看甲任务");
    await waitForTarget(
      homeDir,
      { kind: "task", taskId: remembered },
      "退出前上报"
    );
    await ctl.quit();

    const second = await ctl.relaunch();
    await assertCurrentSession(
      second.window,
      remembered,
      "重开应回到退出前查看的甲任务"
    );
    // 侧栏顺序证明打开来源是启动现场：排序最前的未归档是乙，不是被打开的甲
    assert(
      (await firstActiveSessionId(second.window)) === front,
      "排序最前的未归档应是乙（对照组），否则无法证明恢复走启动现场"
    );
  });

  await scenario("② 归档任务照常恢复", async (homeDir, ctl) => {
    const { window } = await ctl.launch();
    await window.evaluate(() => localStorage.clear());
    await createProfile(window, port);
    await createSession(window, "归档目标任务");
    await createSession(window, "未归档搭档任务");
    const archived = await sessionIdByTitle(window, "归档目标任务");
    const menu = await taskMenu(
      window,
      window.getByTestId("task-item").filter({ hasText: "归档目标任务" })
    );
    await menu.getByTestId("archive-button").click();
    await window
      .getByTestId("archived-task-item")
      .waitFor({ state: "detached" });
    await window
      .getByTestId("standalone-header")
      .locator("..")
      .getByTestId("toggle-archived")
      .click();
    await window
      .getByTestId("archived-task-item")
      .filter({ hasText: "归档目标任务" })
      .click();
    await assertCurrentSession(window, archived, "退出前应查看归档任务");
    await waitForTarget(
      homeDir,
      { kind: "task", taskId: archived },
      "归档目标上报"
    );
    await ctl.quit();

    const second = await ctl.relaunch();
    await assertCurrentSession(
      second.window,
      archived,
      "重开应照常回到归档任务"
    );
  });

  await scenario(
    "③ 新建草稿（含项目关联）重开回到同样草稿状态",
    async (homeDir, ctl) => {
      const { window } = await ctl.launch();
      await window.evaluate(() => localStorage.clear());
      await createProfile(window, port);
      await window.getByTestId("add-project").click();
      await window.getByTestId("project-group").waitFor();
      const projectId = (
        await window.evaluate(
          async () => await window.codexlike.projects.list()
        )
      )[0].id;
      await projectAction(window);
      await window.getByTestId("composer-input").fill("项目草稿待恢复文本");
      await assertNoOpenSession(window, "草稿态不应打开任何任务");
      await waitForTarget(homeDir, { kind: "new", projectId }, "草稿目标上报");
      await ctl.quit();

      const second = await ctl.relaunch();
      await second.window.getByTestId("project-group").waitFor();
      await assertNoOpenSession(
        second.window,
        "重开应停在项目草稿（无打开任务）"
      );
      await untilDraft(
        second.window,
        "项目草稿待恢复文本",
        "重开后项目草稿文本应随 workbench_state 恢复"
      );
      assert(
        readState(homeDir).workbenchTarget.projectId === projectId,
        "重开后现场仍记录项目关联"
      );
    }
  );

  await scenario(
    "④ 设置页重开仍在设置页，目标字段独立",
    async (homeDir, ctl) => {
      const { window } = await ctl.launch();
      await window.evaluate(() => localStorage.clear());
      await createProfile(window, port);
      await createSession(window, "设置页下的任务");
      const sessionId = await sessionIdByTitle(window, "设置页下的任务");
      await window.getByTestId("settings-open").click();
      await waitForView(homeDir, "settings", "切到设置页上报视图");
      await waitForTarget(
        homeDir,
        { kind: "task", taskId: sessionId },
        "设置页下目标保持"
      );
      await ctl.quit();

      const second = await ctl.relaunch();
      await second.window
        .getByTestId("settings-back")
        .waitFor({ timeout: 10_000 });
      await second.window.getByTestId("settings-back").click();
      await assertCurrentSession(
        second.window,
        sessionId,
        "从设置页返回工作区仍显示最后打开的任务"
      );
    }
  );

  await scenario(
    "⑤a 记住的任务已不存在→回退排序最前未归档",
    async (homeDir, ctl) => {
      const { window } = await ctl.launch();
      await window.evaluate(() => localStorage.clear());
      await createProfile(window, port);
      await createSession(window, "回退见证任务");
      await createSession(window, "将被删目标任务");
      const fallback = await sessionIdByTitle(window, "回退见证任务");
      // 归档「将被删目标任务」：它不再是回退候选（回退链只找未归档），
      // 唯一未归档剩「回退见证任务」——与记住目标有真实区分度
      const menu = await taskMenu(
        window,
        window.getByTestId("task-item").filter({ hasText: "将被删目标任务" })
      );
      await menu.getByTestId("archive-button").click();
      await window
        .getByTestId("archived-task-item")
        .waitFor({ state: "detached" });
      // 退出前正在查看的是归档的「将被删目标任务」
      await window
        .getByTestId("standalone-header")
        .locator("..")
        .getByTestId("toggle-archived")
        .click();
      await window
        .getByTestId("archived-task-item")
        .filter({ hasText: "将被删目标任务" })
        .click();
      const gone = await sessionIdByTitle(window, "将被删目标任务");
      await assertCurrentSession(window, gone, "退出前查看归档目标");
      await waitForTarget(homeDir, { kind: "task", taskId: gone }, "目标上报");
      await ctl.quit();

      // 两次启动之间把记住的任务指向不存在的 id（模拟记住的任务已被删除）
      const state = readState(homeDir);
      state.workbenchTarget.taskId = "ghost-task-id";
      writeFileSync(
        join(homeDir, STATE_FILE),
        JSON.stringify(state, null, 2),
        "utf8"
      );

      const second = await ctl.relaunch();
      await assertCurrentSession(
        second.window,
        fallback,
        "记住的任务失效应回退到排序最前的未归档任务（回退见证）"
      );
    }
  );

  await scenario("⑤b 无可打开任务→停新建草稿入口", async (homeDir, ctl) => {
    const { window } = await ctl.launch();
    await window.evaluate(() => localStorage.clear());
    await createProfile(window, port);
    await createSession(window, "独苗任务");
    const only = await sessionIdByTitle(window, "独苗任务");
    const menu = await taskMenu(
      window,
      window.getByTestId("task-item").filter({ hasText: "独苗任务" })
    );
    await menu.getByTestId("archive-button").click();
    await window
      .getByTestId("archived-task-item")
      .waitFor({ state: "detached" });
    await window
      .getByTestId("standalone-header")
      .locator("..")
      .getByTestId("toggle-archived")
      .click();
    await window
      .getByTestId("archived-task-item")
      .filter({ hasText: "独苗任务" })
      .click();
    await assertCurrentSession(window, only, "退出前查看归档独苗");
    await waitForTarget(homeDir, { kind: "task", taskId: only }, "目标上报");
    await ctl.quit();

    // 记住的目标失效且无未归档任务：与现有冷启动一致，停在新建草稿入口
    const state = readState(homeDir);
    state.workbenchTarget.taskId = "ghost-task-id";
    writeFileSync(
      join(homeDir, STATE_FILE),
      JSON.stringify(state, null, 2),
      "utf8"
    );

    const second = await ctl.relaunch();
    await assertIdleNewSessionEntry(
      second.window,
      "无可打开任务时应停在新建草稿入口"
    );
  });

  await scenario("⑥ kill 进程后现场照样恢复", async (homeDir, ctl) => {
    const { window } = await ctl.launch();
    await window.evaluate(() => localStorage.clear());
    await createProfile(window, port);
    await createSession(window, "强杀前任务");
    await createSession(window, "强杀后最新任务");
    const remembered = await sessionIdByTitle(window, "强杀前任务");
    await selectSession(window, "强杀前任务");
    await assertCurrentSession(window, remembered, "强杀前查看目标任务");
    await waitForTarget(
      homeDir,
      { kind: "task", taskId: remembered },
      "目标上报"
    );
    // 强杀：不经退出屏障，现场只剩之前即时落盘的上报
    await ctl.kill();

    const second = await ctl.relaunch();
    await assertCurrentSession(
      second.window,
      remembered,
      "kill 后重开应照样回到强杀前查看的任务"
    );
  });

  await scenario("⑦ 无现场文件时冷启动行为与现状一致", async (homeDir, ctl) => {
    const { window } = await ctl.launch();
    await window.evaluate(() => localStorage.clear());
    await createProfile(window, port);
    await createSession(window, "较早任务");
    await createSession(window, "最新任务");
    const front = await sessionIdByTitle(window, "最新任务");
    await selectSession(window, "较早任务");
    await assertCurrentSession(
      window,
      await sessionIdByTitle(window, "较早任务"),
      "退出前查看较早任务"
    );
    await ctl.quit();

    // 删除现场文件：冷启动回到现有行为——排序最前的未归档任务（最新任务），
    // 而不是退出前正在查看的较早任务
    rmSync(join(homeDir, STATE_FILE));

    const second = await ctl.relaunch();
    await assertCurrentSession(
      second.window,
      front,
      "无现场文件应打开排序最前的未归档任务（现有冷启动行为）"
    );
    assert(
      (await firstActiveSessionId(second.window)) === front,
      "对照组：排序最前的未归档任务应与打开的一致"
    );
  });

  await scenario("⑧ 设置页往返重挂不重恢复启动目标", async (homeDir, ctl) => {
    const { window } = await ctl.launch();
    await window.evaluate(() => localStorage.clear());
    await createProfile(window, port);
    await createSession(window, "往返甲任务");
    await createSession(window, "往返乙任务");
    const remembered = await sessionIdByTitle(window, "往返甲任务");
    const switched = await sessionIdByTitle(window, "往返乙任务");
    await selectSession(window, "往返甲任务");
    await assertCurrentSession(window, remembered, "退出前应查看甲任务");
    await waitForTarget(
      homeDir,
      { kind: "task", taskId: remembered },
      "退出前上报"
    );
    await ctl.quit();

    const second = await ctl.relaunch();
    await assertCurrentSession(
      second.window,
      remembered,
      "冷启动应恢复到启动目标甲"
    );
    await selectSession(second.window, "往返乙任务");
    await assertCurrentSession(second.window, switched, "运行中切到乙");
    await waitForTarget(
      homeDir,
      { kind: "task", taskId: switched },
      "切乙上报"
    );

    // 设置页往返（同一实例内卸载重挂 WorkspacePage，不重启）：重挂后冷启动
    // 效应异步执行，先等任一任务成为当前（恢复完成），再留出时间窗断言
    // 既不拉回甲也不把甲写回现场
    await second.window.getByTestId("settings-open").click();
    await second.window.getByTestId("settings-back").click();
    await until(
      async () => (await currentSessionId(second.window)) !== null,
      "设置页返回后应恢复显示某个任务"
    );
    await delay(2000);
    assert(
      (await currentSessionId(second.window)) === switched,
      `设置页返回后应仍显示乙（不被拉回启动目标甲，实际 ${await currentSessionId(second.window)}）`
    );
    const state = readState(homeDir);
    assert(
      state.workbenchTarget?.kind === "task" &&
        state.workbenchTarget.taskId === switched,
      "设置页往返后现场目标应仍是乙"
    );

    await ctl.quit();
    const third = await ctl.relaunch();
    await assertCurrentSession(
      third.window,
      switched,
      "再重启仍回乙（现场未被启动目标覆盖）"
    );
  });
}

main().catch((error) => {
  console.error("[e2e] 启动现场目标与视图失败：", error);
  process.exitCode = 1;
});
