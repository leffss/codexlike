// 票08：真实进程退出/重开；模型计数与文件追加副作用独立证明不重放。
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  selectComposerOption,
  assert,
  assertSemanticOverlay,
  launchApp,
  projectAction,
  startMockProvider,
  untilDraft,
} from "./helpers.mjs";

const questions = [
  {
    id: "q",
    header: "下一步",
    question: "接下来如何处理？",
    multiSelect: false,
    options: [{ id: "a", label: "继续" }],
  },
];
const longText = Array.from(
  { length: 100 },
  (_, i) => `历史段落 ${i + 1}：退出后保留阅读位置。`
).join("\n\n");
async function until(predicate, message) {
  const end = Date.now() + 10000;
  while (!(await predicate())) {
    assert(Date.now() < end, message);
    await delay(25);
  }
}
function exited(app) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("应用进程未正常结束")),
      15000
    );
    app.process().once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
async function quit(app, window, confirm) {
  const done = exited(app);
  await app.evaluate(({ app }) => {
    app.quit();
  });
  if (confirm) await window.getByTestId("exit-confirm").click();
  const result = await done;
  assert(result.code === 0 && result.signal === null, "受控退出没有测试强杀");
}
async function send(window, text) {
  await window.getByTestId("composer-input").fill(text);
  await window.getByTestId("composer-send").click();
}
async function select(window, title) {
  await window.getByTestId("task-item").filter({ hasText: title }).click();
}
async function main() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-exit-recovery-"));
  const homeDir = join(root, "fresh", "home");
  const workspaceDir = join(root, "project");
  mkdirSync(workspaceDir);
  const held = new Map();
  let childDisconnected = false;
  const model = await startMockProvider((ctx, { body }) => {
    const data = JSON.parse(body);
    const text = data.messages.filter((m) => m.role === "user").at(-1)?.content;
    const tool = (id) =>
      data.messages.some((m) => m.role === "tool" && m.tool_call_id === id);
    if (
      data.messages.some(
        (m) => m.role === "system" && m.content.includes("CodexLike 的子代理")
      )
    ) {
      ctx.send({ delta: { content: "子代理正在执行" }, finish_reason: null });
      ctx.res.once("close", () => {
        childDisconnected = true;
      });
      held.set("child", ctx);
    } else if (text === "长历史") ctx.textRound(longText);
    else if (text === "项目慢任务" || text === "异常慢任务") {
      const id = text === "项目慢任务" ? "append" : "crash-append";
      if (!tool(id))
        ctx.toolCallRound(id, "run_terminal_command", {
          command: `printf 'once\n' >> ${id}.txt`,
        });
      else {
        ctx.send({
          delta: { content: `${text}已执行文件追加，继续等待` },
          finish_reason: null,
        });
        held.set(text, ctx);
      }
    } else if (text === "独立问答")
      ctx.toolCallRound("question", "ask_user_question", { questions });
    else if (text === "后台审批")
      ctx.toolCallRound("approval", "write_file", {
        path: "must-not-write.txt",
        content: "无授权不能写",
      });
    else if (text === "子代理任务") {
      if (!tool("spawn"))
        ctx.toolCallRound("spawn", "spawn_subagent", {
          task: "执行慢速子任务",
        });
      else ctx.textRound("主代理等待子代理收尾");
    } else ctx.textRound("明确发送后的新答复");
  });
  let app;
  let window;
  try {
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await window.getByTestId("new-task").waitFor();
    // 只配置外部模型经公开preload；实际发送、草稿、问答、滚动和退出均真实点击。
    await window.evaluate(async (port) => {
      await window.codexlike.providerProfiles.create({
        name: "Exit Mock",
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: "test",
        models: ["mock-model"],
      });
    }, model.port);
    await window.getByTestId("settings-open").click();
    // 场景峰值 5 任务并发（项目慢任务/独立问答/后台审批/子代理任务活跃到
    // 退出，长历史终态收口），超 ADR 0022 默认上限 3：不调上限时第 4 个任务
    // 满员入队排队（waiting-user 占坑不释放），子代理模型请求永不发出。经
    // 设置页调到 5 保持场景「多任务同时活跃过退出」的验证意图；设置随
    // homeDir 持久化，重启后的进程沿用，无额外自动开跑（退出时无排队条目）。
    await window.getByTestId("execution-task-concurrency-input").fill("5");
    await window.getByTestId("execution-settings-save").click();
    await window.getByTestId("settings-back").click();
    await window.getByTestId("add-project").click();
    await projectAction(window);
    await selectComposerOption(window, "approval-mode-select", "assist");
    await send(window, "项目慢任务");
    await window
      .getByTestId("tool-call-card")
      .filter({ hasText: "run_terminal_command" })
      .waitFor();
    await until(
      () => existsSync(join(workspaceDir, "append.txt")),
      "文件副作用没有发生"
    );
    await until(() => held.has("项目慢任务"), "工具后模型继续等待");
    assert(
      readFileSync(join(workspaceDir, "append.txt"), "utf8") === "once\n",
      "工具只追加一次"
    );

    await window.getByTestId("new-task").click();
    await send(window, "独立问答");
    await window.getByTestId("question-custom").fill("尚未提交的退出问答草稿");
    const pending = await window.evaluate(async () => {
      const record = (await window.codexlike.tasks.list()).find(
        (s) => s.title === "独立问答"
      );
      return {
        task: record,
        request: (
          await window.codexlike.tasks.pendingInteractions(record.id)
        )[0].request,
      };
    });
    await window.getByTestId("new-task").click();
    await send(window, "后台审批");
    await window.getByTestId("approval-approve").waitFor();
    const approval = await window.evaluate(async () => {
      const record = (await window.codexlike.tasks.list()).find(
        (s) => s.title === "后台审批"
      );
      return {
        task: record,
        request: (
          await window.codexlike.tasks.pendingInteractions(record.id)
        )[0].request,
      };
    });
    await window.getByTestId("new-task").click();
    await send(window, "子代理任务");
    await until(() => held.has("child"), "子代理模型未启动");
    await window.getByTestId("subagent-stream-marker-toggle").waitFor();
    await window.getByTestId("new-task").click();
    await send(window, "长历史");
    await window.getByTestId("message-assistant").waitFor();
    await window.getByTestId("composer-send").waitFor();
    await window.getByTestId("composer-input").fill("正式任务未发送输入");
    await selectComposerOption(window, "thinking-effort-select", "high");
    const stream = window.getByTestId("message-stream");
    await stream.hover();
    await window.mouse.wheel(0, 800);
    await window.waitForFunction(
      () =>
        document.querySelector('[data-testid="message-stream"]').scrollTop > 500
    );
    const readingTop = await stream.evaluate((el) => el.scrollTop);
    await projectAction(window);
    await window.getByTestId("composer-input").fill("项目新建草稿");
    await window.getByTestId("new-task").click();
    await window.getByTestId("composer-input").fill("独立新建草稿");
    await window.getByTestId("project-group").click();
    await window.getByTestId("task-search-toggle").click();
    await window.getByTestId("task-search-input").fill("长历史");

    // 关闭按钮入口（ADR 0025 托盘驻留）：点 X 只驻留——窗口隐藏、任务不停；
    // 退出确认只在托盘菜单「退出」等价路径（app.quit）下出现，取消不提前停止。
    await window.getByTestId("window-close").click();
    const resided = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return !win.isVisible();
    });
    assert(resided, "关闭按钮必须隐藏主窗口（驻留托盘）");
    assert(!childDisconnected, "驻留不停止子代理模型连接");
    await app.evaluate(({ app }) => {
      app.quit();
    });
    await window.getByTestId("exit-confirm").waitFor();
    assert(
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return win.isVisible() && !win.isMinimized() && win.isFocused();
      }),
      "托盘退出必须主动显示、恢复并聚焦确认窗口"
    );
    await assertSemanticOverlay(
      window.getByTestId("exit-confirm").locator("../..")
    );
    assert(!childDisconnected, "确认前子代理没有被停止");
    await window.getByTestId("exit-cancel").click();
    held
      .get("项目慢任务")
      .send({ delta: { content: "取消退出后继续生成" }, finish_reason: null });
    await window.getByTestId("task-search-toggle").click();
    await window.getByTestId("project-group").click();
    await select(window, "项目慢任务");
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "取消退出后继续生成" })
      .waitFor();
    await select(window, "独立问答");
    assert(
      (await window.getByTestId("question-custom").inputValue()) ===
        "尚未提交的退出问答草稿",
      "取消退出保留有效问答及草稿"
    );
    await select(window, "长历史");
    await window.waitForFunction(
      (top) =>
        Math.abs(
          document.querySelector('[data-testid="message-stream"]').scrollTop -
            top
        ) < 4,
      readingTop
    );
    // 真IPC保存边界注入一次写失败：不能静默退出或提前停止后台任务。
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get("workbench:write");
      globalThis.exitWriteGate = {
        fail: true,
        failed: false,
        hold: false,
        entered: false,
        release: null,
      };
      ipcMain.removeHandler("workbench:write");
      ipcMain.handle("workbench:write", async (event, target, entry) => {
        const gate = globalThis.exitWriteGate;
        if (gate.fail) {
          gate.fail = false;
          gate.failed = true;
          throw new Error("模拟磁盘写失败");
        }
        if (gate.hold && entry.value.text === "最后一笔立即退出输入") {
          gate.entered = true;
          await new Promise((resolve) => {
            gate.release = resolve;
          });
        }
        return original(event, target, entry);
      });
    });
    await window.getByTestId("composer-input").fill("保存失败仍保留输入");
    // fill 触发的草稿 write 与 quit 后保存屏障的 flush 赛跑：write 尚未排队
    // 时 flush 会空跑成功并直接退出，exit-error 永不出现。等注入确定的
    // failed 信号（失败已被消费、渲染侧 errors 已落账）再触发退出。
    await until(
      () => app.evaluate(() => globalThis.exitWriteGate.failed),
      "写失败注入未被触发"
    );
    await app.evaluate(({ app }) => {
      app.quit();
    });
    await window.getByTestId("exit-confirm").click();
    await window
      .getByTestId("exit-error")
      .filter({ hasText: "模拟磁盘写失败" })
      .waitFor();
    assert(!childDisconnected, "flush失败不停止后台子代理");
    assert(
      await window.getByTestId("composer-input").isEditable(),
      "保存失败后恢复编辑"
    );
    await app.evaluate(() => {
      globalThis.exitWriteGate.hold = true;
    });
    await window.getByTestId("composer-input").fill("最后一笔立即退出输入");
    await until(
      () => app.evaluate(() => globalThis.exitWriteGate.entered),
      "保存屏障没有进入"
    );
    const count = model.requestCount();
    const done = exited(app);
    // 托盘「退出」等价路径（app.quit → 退出屏障）：flush 挂起期间不停止执行
    await app.evaluate(({ app }) => {
      app.quit();
    });
    await window.getByTestId("exit-confirm").click();
    await window
      .getByTestId("exit-progress")
      .filter({ hasText: "正在保存" })
      .waitFor();
    assert(!childDisconnected, "延迟保存回执前不停止执行");
    assert(
      await window
        .getByTestId("composer-input")
        .evaluate((el) => el.closest("[inert]") !== null),
      "flush前已冻结编辑"
    );
    await app.evaluate(() => {
      globalThis.exitWriteGate.release();
    });
    const result = await done;
    assert(
      result.code === 0 && result.signal === null,
      "flush后正常退出而非测试强杀"
    );
    app = null;
    await until(() => childDisconnected, "退出未中断子代理模型连接");
    assert(
      !existsSync(join(approval.task.workspacePath, "must-not-write.txt")),
      "旧审批未执行"
    );
    assert(model.requestCount() === count, "确认退出未触发额外模型请求");

    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await select(window, "长历史");
    await window.getByTestId("message-assistant").waitFor();
    await window.waitForFunction(
      (top) =>
        Math.abs(
          document.querySelector('[data-testid="message-stream"]').scrollTop -
            top
        ) < 4,
      readingTop
    );
    // 草稿经异步 workbench 读取载入，滚动恢复完成不保证草稿已回填：
    // 等待到达期望文本（确定信号）而非立即断言。
    await untilDraft(window, "最后一笔立即退出输入", "退出前最后草稿已持久化");
    assert(
      (await window
        .getByTestId("thinking-effort-select")
        .getAttribute("data-value")) === "high",
      "设置重开恢复"
    );
    await projectAction(window);
    await untilDraft(window, "项目新建草稿", "项目草稿恢复");
    await window.getByTestId("new-task").click();
    await untilDraft(window, "独立新建草稿", "独立草稿恢复");
    await select(window, "独立问答");
    await window
      .getByTestId("saved-question-draft")
      .filter({ hasText: "尚未提交的退出问答草稿" })
      .waitFor();
    assert(
      (await window.getByTestId("interaction-panel").count()) === 0,
      "重启旧问答没有可提交入口"
    );
    const responses = await window.evaluate(
      async ({ pending, approval }) => [
        await window.codexlike.tasks.respondInteraction(
          pending.task.id,
          pending.request.id,
          { kind: "questions", answers: [] }
        ),
        await window.codexlike.tasks.respondApproval(
          approval.task.id,
          approval.request.id,
          "always"
        ),
      ],
      { pending, approval }
    );
    assert(
      responses.every((accepted) => accepted === false),
      "失效请求不可经IPC回应，always也不授永久许可"
    );
    for (const title of ["项目慢任务", "独立问答", "后台审批", "子代理任务"]) {
      const item = window.getByTestId("task-item").filter({ hasText: title });
      assert(
        (await item.getByTestId("task-activity").textContent()) === "已中断",
        `${title}恢复为中断`
      );
    }
    await select(window, "子代理任务");
    await window.getByTestId("subagent-stream-marker-toggle").waitFor();
    await delay(300);
    assert(model.requestCount() === count, "新进程及查看旧历史没有模型请求");
    assert(
      readFileSync(join(workspaceDir, "append.txt"), "utf8") === "once\n",
      "重启没有重放已完成工具"
    );

    // 明确后续发送可继续；旧审批不可成为永久授权。
    await select(window, "后台审批");
    await send(window, "后台审批");
    await window.getByTestId("approval-approve").waitFor();
    assert(
      !existsSync(join(approval.task.workspacePath, "must-not-write.txt")),
      "下一轮仍需新的显式授权"
    );
    await window.getByTestId("composer-stop").click();
    await window.getByTestId("composer-send").waitFor();

    // 异常终止：操作系统杀死进程，重启同库归一，不把异常当正常退出保证。
    await projectAction(window);
    await selectComposerOption(window, "approval-mode-select", "assist");
    await send(window, "异常慢任务");
    await until(() => held.has("异常慢任务"), "异常任务未执行到等待点");
    const crashCount = model.requestCount();
    const crashed = exited(app);
    // Windows必须杀完整测试进程树，避免只杀调试包装进程而留下Electron。
    if (process.platform === "win32")
      execFileSync("taskkill", ["/PID", String(app.process().pid), "/T", "/F"]);
    else app.process().kill("SIGKILL");
    await crashed;
    app = null;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await select(window, "异常慢任务");
    await window
      .getByTestId("task-item")
      .filter({ hasText: "异常慢任务" })
      .getByTestId("task-activity")
      .filter({ hasText: "已中断" })
      .waitFor();
    await delay(300);
    assert(model.requestCount() === crashCount, "异常重启没有自动模型请求");
    assert(
      readFileSync(join(workspaceDir, "crash-append.txt"), "utf8") === "once\n",
      "异常重启没有工具重放"
    );
    await send(window, "用户明确继续");
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "明确发送后的新答复" })
      .waitFor();
    await window.getByTestId("composer-send").waitFor();
    assert(
      model.requestCount() === crashCount + 1,
      "只有显式发送才重新调用模型"
    );
    await quit(app, window, false);
    app = null;
    console.log(
      "PASS exit-recovery: 3真实进程、两种退出入口、取消/确认、主子代理、草稿/滚动、异常恢复、零重放"
    );
  } catch (error) {
    console.error("退出恢复验收失败", error);
    throw error;
  } finally {
    if (app) {
      const done = exited(app);
      await app
        .evaluate(({ app }) => {
          app.exit(137);
        })
        .catch(() => {});
      await done.catch(() => {});
    }
    model.server.closeAllConnections();
    model.server.close();
    try {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch (error) {
      console.error("测试临时目录清理失败", error);
    }
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
