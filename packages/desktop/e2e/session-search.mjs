// 票06：真实 Electron/preload/IPC/SQLite 搜索与历史导航；只替换外部模型。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, closeApp, launchApp, startMockProvider } from "./helpers.mjs";

async function assertSearchLayout(window) {
  const layout = await window
    .getByTestId("task-search-input")
    .evaluate((input) => {
      const panel = input.closest("section");
      const label = input.closest("label");
      const range = document.createRange();
      range.selectNodeContents(label);
      range.setEndBefore(input);
      const description = range.getBoundingClientRect();
      const field = input.getBoundingClientRect();
      const box = panel.getBoundingClientRect();
      const status = panel
        .querySelector('[role="status"]')
        .getBoundingClientRect();
      const actions = panel
        .querySelector('[data-testid="task-search-refresh"]')
        .parentElement.getBoundingClientRect();
      return {
        descriptionBottom: description.bottom,
        inputTop: field.top,
        inputBottom: field.bottom,
        actionsTop: actions.top,
        actionsBottom: actions.bottom,
        statusTop: status.top,
        contained: field.left >= box.left && field.right <= box.right,
        panelVisible: box.left >= 0 && box.right <= innerWidth,
        overflow: panel.scrollWidth > panel.clientWidth + 1,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
  assert(
    layout.inputTop >= layout.descriptionBottom &&
      layout.actionsTop >= layout.inputBottom &&
      layout.statusTop >= layout.actionsBottom &&
      layout.contained &&
      layout.panelVisible &&
      !layout.overflow &&
      !layout.pageOverflow,
    `搜索说明、输入框和状态纵向排列且不溢出：${JSON.stringify(layout)}`
  );
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-task-search-"));
  const homeDir = join(root, "home");
  const workspaceDir = join(root, "折叠项目");
  mkdirSync(workspaceDir);
  let finishBackground;
  const model = await startMockProvider((ctx, { index }) => {
    if (index === 4) {
      ctx.send({ delta: { content: "后台仍在生成" }, finish_reason: null });
      finishBackground = () => {
        if (!ctx.res.writableEnded) ctx.finishWith("stop");
      };
    } else ctx.textRound(`持久正文星河-${index}`);
  });
  let app;
  try {
    let window;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    window.setDefaultTimeout(8000);
    await window.getByTestId("task-search-toggle").click();
    for (const width of [1280, 1000]) {
      await app.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()[0].setContentSize(width, 800),
        width
      );
      await window.waitForFunction((width) => innerWidth === width, width);
      for (const theme of ["light", "dark"]) {
        if (
          (await window.evaluate(
            () => document.documentElement.dataset.theme
          )) !== theme
        )
          await window.getByTestId("theme-toggle").click();
        await window.waitForFunction(
          (theme) => document.documentElement.dataset.theme === theme,
          theme
        );
        await assertSearchLayout(window);
      }
    }
    await window.getByTestId("theme-toggle").click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800)
    );
    await window.waitForFunction(() => innerWidth === 1280);
    await window.getByTestId("task-search-input").press("Escape");
    await window.getByTestId("add-project").click();
    await window.getByTestId("project-group").waitFor();
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const form = window.locator("form");
    await form.getByLabel("名称").fill("Search Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${model.port}/v1`);
    await form.getByLabel("API Key").fill("secret-never-searchable");
    await form.getByLabel("模型").fill("mock-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Search Mock", { exact: true }).waitFor();
    await window.getByTestId("settings-back").click();
    async function create(title, project = false) {
      if (project) await window.getByTestId("project-group").hover();
      await window
        .getByTestId(project ? "project-new-task" : "new-task")
        .click();
      if (!project) await window.getByTestId("draft-select-workspace").click();
      await window.getByTestId("composer-input").fill(title);
      await window.getByTestId("composer-send").click();
      await window.getByTestId("message-assistant").waitFor();
      await window.getByTestId("composer-send").waitFor();
    }
    const item = (title) =>
      window.getByTestId("task-item").filter({ hasText: title });
    const results = () => window.getByTestId("task-search-result");
    async function search(text) {
      if (!(await window.getByTestId("task-search-input").isVisible()))
        await window.getByTestId("task-search-toggle").click();
      await window.getByTestId("task-search-input").fill(text);
      await window
        .getByTestId("task-search-status")
        .filter({ hasText: /找到|没有匹配|输入标题/ })
        .waitFor();
      await assertSearchLayout(window);
    }
    await create("项目任务", true);
    await create("同目录独立任务");
    await create("待归档任务");
    const projectId = await item("项目任务").getAttribute("data-task-id");
    const standaloneId =
      await item("同目录独立任务").getAttribute("data-task-id");
    const archivedId = await item("待归档任务").getAttribute("data-task-id");
    await item("待归档任务").click({ button: "right" });
    await window
      .getByTestId("task-context-menu")
      .getByTestId("archive-button")
      .click();
    await item("待归档任务").waitFor({ state: "detached" });
    await window.getByTestId("project-group").click();
    assert((await item("项目任务").count()) === 0, "项目折叠隐藏日常列表");
    await search("星河");
    assert(
      (await results().count()) === 2,
      "正文搜索覆盖折叠项目与独立任务，默认排除归档"
    );
    assert(
      (await results().filter({ hasText: "项目任务" }).textContent()).includes(
        "折叠项目"
      ),
      "结果显示显式项目归属"
    );
    assert(
      (
        await results().filter({ hasText: "同目录独立任务" }).textContent()
      ).includes("独立任务"),
      "同目录独立归属不混淆"
    );
    const beforeOpen = await window.evaluate(() =>
      window.codexlike.tasks.list()
    );
    const projectBeforeOpen = beforeOpen.find((task) => task.id === projectId);
    await results().filter({ hasText: "项目任务" }).click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "持久正文星河-1" })
      .waitFor();
    const list = await window.evaluate(() => window.codexlike.tasks.list());
    assert(
      list.find((task) => task.id === projectId).lastUsedAt ===
        projectBeforeOpen.lastUsedAt,
      "搜索打开不得更新 lastUsedAt"
    );
    assert(
      JSON.stringify(list.map((task) => task.id)) ===
        JSON.stringify(beforeOpen.map((task) => task.id)),
      "搜索打开不得改变最近使用顺序"
    );
    await search("星河");
    await window.getByTestId("task-search-archived").check();
    await results().filter({ hasText: "待归档任务" }).waitFor();
    assert((await results().count()) === 3, "归档开关立即纳入归档结果");
    assert(
      (
        await results().filter({ hasText: "待归档任务" }).textContent()
      ).includes("已归档"),
      "结果标记归档"
    );
    await results().filter({ hasText: "待归档任务" }).click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "持久正文星河-3" })
      .waitFor();
    assert(
      await window.getByTestId("composer-send").isDisabled(),
      "归档历史可看不可发送"
    );
    await window
      .getByTestId("archived-task-item")
      .filter({ hasText: "待归档任务" })
      .click({ button: "right" });
    await window
      .getByTestId("task-context-menu")
      .getByTestId("unarchive-button")
      .click();
    await item("待归档任务").waitFor();
    await search("星河");
    await window.getByTestId("task-search-archived").uncheck();
    await results().filter({ hasText: "待归档任务" }).waitFor();
    await window.getByTestId("task-search-toggle").click();
    await item("同目录独立任务").click({ button: "right" });
    await window
      .getByTestId("task-context-menu")
      .getByTestId("rename-button")
      .click();
    await window.getByTestId("rename-input").fill("唯一标题100%_新名");
    await window.getByTestId("rename-input").press("Enter");
    await item("唯一标题100%_新名").waitFor();
    await search("唯一标题100%_");
    assert((await results().count()) === 1, "特殊字符按字面查询重命名后的标题");
    assert(
      (await results().getAttribute("data-task-id")) === standaloneId,
      "标题结果为正确任务"
    );
    await search("secret-never-searchable");
    assert((await results().count()) === 0, "私密配置不进入搜索");
    await search("");
    assert((await results().count()) === 0, "清空查询清除结果");
    await closeApp(app);
    app = null;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    window.setDefaultTimeout(8000);
    await search("星河-3");
    assert(
      (await results().getAttribute("data-task-id")) === archivedId,
      "真实进程重开读取SQLite历史"
    );
    await results().click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "持久正文星河-3" })
      .waitFor();
    assert(model.requestCount() === 3, "搜索与重启不自动发模型请求");
    // 在真实IPC返回边界加闸门：仍查询真实SQL，只控制应答顺序，不伪造结果。
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get("tasks:search");
      globalThis.searchGate = null;
      ipcMain.removeHandler("tasks:search");
      ipcMain.handle("tasks:search", async (event, query, archived) => {
        const result = await original(event, query, archived);
        const gate = globalThis.searchGate;
        if (gate && gate.query === query && !gate.entered) {
          gate.entered = true;
          await new Promise((resolve) => {
            gate.release = resolve;
          });
          if (gate.reject) throw new Error("迟到查询错误");
        }
        return result;
      });
    });
    async function holdQuery(query, reject = false) {
      await app.evaluate(
        (_electron, options) => {
          globalThis.searchGate = { ...options, entered: false, release: null };
        },
        { query, reject }
      );
      if (!(await window.getByTestId("task-search-input").isVisible()))
        await window.getByTestId("task-search-toggle").click();
      await window.getByTestId("task-search-input").fill(query);
      await window
        .getByTestId("task-search-status")
        .filter({ hasText: "正在搜索" })
        .waitFor();
      await assertSearchLayout(window);
      assert(
        await app.evaluate(() => globalThis.searchGate.entered),
        "旧查询已到达真实IPC闸门"
      );
    }
    async function releaseQuery() {
      await app.evaluate(() => globalThis.searchGate.release());
      // 同通道往返+绘制帧屏障，确保迟到结果已被页面处理，不用任意延时判竞态。
      await window.evaluate(async () => {
        await window.codexlike.tasks.search("IPC绘制屏障");
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
    }
    await holdQuery("星河-1", true);
    await releaseQuery();
    await window
      .getByTestId("task-search-status")
      .filter({ hasText: "搜索失败" })
      .waitFor();
    await assertSearchLayout(window);
    await search("");
    await holdQuery("星河-1");
    await search("星河-2");
    assert(
      (await results().getAttribute("data-task-id")) === standaloneId,
      "新查询先返回正确结果"
    );
    await releaseQuery();
    assert(
      (await results().getAttribute("data-task-id")) === standaloneId,
      "旧查询迟到不能覆盖新查询"
    );
    await holdQuery("星河-1");
    await search("");
    await releaseQuery();
    assert((await results().count()) === 0, "清空查询后旧结果不能重新出现");
    await holdQuery("星河-1", true);
    await search("星河-2");
    await releaseQuery();
    assert(
      (await results().getAttribute("data-task-id")) === standaloneId,
      "旧查询失败不清除新结果"
    );
    assert(
      !(await window.getByTestId("task-search-status").textContent()).includes(
        "失败"
      ),
      "迟到错误不污染当前状态"
    );
    await results().click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "持久正文星河-2" })
      .waitFor();
    // 后台运行场景仍从原归档恢复的任务发起。
    await search("星河-3");
    await results().click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "持久正文星河-3" })
      .waitFor();
    await window.getByTestId("composer-input").fill("后台任务保持执行");
    await window.getByTestId("composer-send").click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "后台仍在生成" })
      .waitFor();
    await search("唯一标题100%_");
    await results().click();
    await window
      .getByTestId("message-assistant")
      .filter({ hasText: "持久正文星河-2" })
      .waitFor();
    const execution = await window.evaluate(
      (id) => window.codexlike.tasks.execution(id),
      archivedId
    );
    assert(execution.running, "搜索打开其他任务不停止后台执行");
    finishBackground();
    console.log(
      "[e2e] 跨归属正文/标题、折叠、归档查看恢复、字面字符、真实重开与后台执行通过"
    );
  } finally {
    finishBackground?.();
    if (app) await closeApp(app);
    model.server.close();
    model.server.closeAllConnections();
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
