// 票05：真实 Electron 侧栏布局、菜单、稳定排序、归档与进程重开。
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
import {
  assert,
  closeApp,
  hoverClick,
  hoverFor,
  launchApp,
  projectAction,
  sessionMenu,
  startMockProvider,
} from "./helpers.mjs";

// opacity:0 仍可能被 Playwright 判为 visible，必须检查祖先透明度和实际命中。
async function appearance(locator) {
  return locator.evaluate((node) => {
    let opacity = 1;
    for (let parent = node; parent; parent = parent.parentElement)
      opacity *= Number(getComputedStyle(parent).opacity);
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    return {
      opacity,
      visibility: style.visibility,
      pointerEvents: style.pointerEvents,
      hit: hit === node || node.contains(hit),
    };
  });
}
// hover/focus 显隐由 :hover 样式重算驱动（帧时序不定），单次断言会在
// 重算完成前读到旧态偶发失败；轮询至到达期望态（有界），到不了才报错。
async function assertAction(locator, shown, message) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const state = await appearance(locator);
    const reached = shown
      ? state.opacity === 1 && state.pointerEvents !== "none" && state.hit
      : state.opacity === 0 && state.pointerEvents === "none" && !state.hit;
    if (reached) return;
    assert(Date.now() < deadline, `${message}：${JSON.stringify(state)}`);
    await delay(50);
  }
}

// 用真实文字 Range 测量起点，避免按钮盒子包含箭头/图标时掩盖层级倒置。
async function textAppearance(locator, text) {
  return locator.evaluate((node, text) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let label;
    while ((label = walker.nextNode())) {
      if (label.textContent.trim() !== text) continue;
      const range = document.createRange();
      range.selectNodeContents(label);
      const style = getComputedStyle(label.parentElement);
      return {
        x: range.getBoundingClientRect().left,
        weight: Number(style.fontWeight),
        color: style.color,
      };
    }
    throw new Error(`找不到文字：${text}`);
  }, text);
}

async function assertProjectHierarchy(window) {
  const project = window.getByTestId("project-header").locator("..");
  const heading = await textAppearance(
    project.getByTestId("project-group"),
    "项目"
  );
  const child = await textAppearance(
    project.getByTestId("session-item").filter({ hasText: "项目任务" }),
    "项目任务"
  );
  assert(
    child.x >= heading.x + 8,
    `子会话文字应明显位于项目文字右侧：${JSON.stringify({ heading, child })}`
  );
  assert(heading.weight >= 600, "项目名称使用清晰的半粗字重");
  const colors = await window.getByTestId("session-list").evaluate((node) => {
    const probe = document.createElement("span");
    node.append(probe);
    const result = {};
    for (const token of ["fg", "line", "selected"]) {
      probe.style.color = `var(--${token})`;
      result[token] = getComputedStyle(probe).color;
    }
    probe.remove();
    return result;
  });
  assert(heading.color === colors.fg, "项目名称使用主题主前景色");
  assert(child.color !== heading.color, "非当前会话保持较弱的前景层级");
  const guide = await project.getByTestId("group-sessions").evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      width: Number.parseFloat(style.borderLeftWidth),
      color: style.borderLeftColor,
      style: style.borderLeftStyle,
      height: node.getBoundingClientRect().height,
    };
  });
  // Windows 125% DPI 下 1px CSS 边框可能计算为 0.8px，验证可见细线而非精确整数。
  assert(
    guide.width > 0 &&
      guide.width <= 1.5 &&
      guide.color === colors.line &&
      guide.style === "solid" &&
      guide.height > 0,
    `展开会话使用淡色竖向引导线：${JSON.stringify(guide)}`
  );
  const projectBox = await project.boundingBox();
  const standaloneBox = await window
    .getByTestId("standalone-header")
    .boundingBox();
  assert(
    standaloneBox.y - (projectBox.y + projectBox.height) >= 16,
    "项目排在独立分区之前，两者保留至少 16px 间距"
  );
  const selected = project.getByTestId("session-row").filter({
    has: window.getByTestId("session-item").filter({ hasText: "项目次任务" }),
  });
  assert(
    (await selected
      .getByTestId("session-item")
      .getAttribute("aria-current")) === "page",
    "当前项目会话保持选中语义"
  );
  assert(
    (await selected.evaluate(
      (node) => getComputedStyle(node).backgroundColor
    )) === colors.selected,
    "当前会话仍使用主题选中底色"
  );
  for (const locator of [project, project.getByTestId("project-header")]) {
    assert(
      (await locator.evaluate(
        (node) => getComputedStyle(node).backgroundColor
      )) === "rgba(0, 0, 0, 0)",
      "项目组及项目头默认透明，不引入大块底色"
    );
  }
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-sidebar-"));
  const homeDir = join(root, "home");
  const workspaceDir = join(root, "项目");
  mkdirSync(workspaceDir);
  const marker = join(workspaceDir, "keep.txt");
  writeFileSync(marker, "归档不能删除成果");
  const model = await startMockProvider((ctx, { index }) => {
    if (index === 5)
      ctx.toolCallRound("question", "ask_user_question", {
        questions: [
          {
            id: "q",
            header: "任务",
            question: "选择后继续？",
            multiSelect: false,
            options: [{ id: "yes", label: "继续" }],
          },
        ],
      });
    else ctx.textRound("整理验收完成");
  });
  let app;
  try {
    let window;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await window.getByTestId("add-project").click();
    await window.getByTestId("project-group").waitFor();
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const form = window.locator("form");
    await form.getByLabel("名称").fill("Sidebar Mock");
    await form.getByLabel("baseURL").fill(`http://127.0.0.1:${model.port}/v1`);
    await form.getByLabel("API Key").fill("test");
    await form.getByLabel("模型").fill("mock-model");
    await form.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText("Sidebar Mock", { exact: true }).waitFor();
    await window.getByTestId("settings-back").click();
    async function create(title, project = false) {
      if (project) await projectAction(window);
      else {
        await window.getByTestId("new-session").click();
        await window.getByTestId("draft-select-workspace").click();
      }
      await window.getByTestId("composer-input").fill(title);
      await window.getByTestId("composer-send").click();
      await window.getByTestId("message-assistant").waitFor();
      await window.getByTestId("composer-send").waitFor();
    }
    const item = (title, archived = false) =>
      window
        .getByTestId(archived ? "archived-session-item" : "session-item")
        .filter({ hasText: title });
    const group = () => window.getByTestId("standalone-header").locator("..");
    const project = () => window.getByTestId("project-header").locator("..");
    const menu = () => window.getByTestId("session-context-menu");
    const currentId = () =>
      window
        .getByTestId("session-row")
        .locator('[aria-current="page"]')
        .getAttribute("data-session-id");
    const row = (id) =>
      window
        .getByTestId("session-row")
        .and(window.locator(`[data-session-id="${id}"]`));
    const records = () =>
      window.evaluate(() => window.codexlike.sessions.list());
    const order = (scope, archived = false) =>
      scope
        .getByTestId(archived ? "archived-session-item" : "session-item")
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.sessionId));
    const timestamps = async () =>
      Object.fromEntries((await records()).map((s) => [s.id, s.lastUsedAt]));
    async function action(title, testId, archived = false) {
      await (
        await sessionMenu(window, item(title, archived))
      )
        .getByTestId(testId)
        .click();
    }
    async function select(title, archived = false) {
      await item(title, archived).click();
      await window
        .getByTestId("message-user")
        .filter({ hasText: title })
        .waitFor();
    }
    async function neutral() {
      await window.getByTestId("composer-input").focus();
      await window.getByTestId("session-title").hover();
    }
    async function assertFocused(testId) {
      assert(
        await window
          .getByTestId(testId)
          .evaluate((node) => node === document.activeElement),
        `焦点位于 ${testId}`
      );
    }
    await create("项目任务", true);
    await create("项目次任务", true);
    await create("独立A");
    await create("独立B");

    // 同一真实项目下两条会话：非当前行显示层级，当前行保留最强高亮。
    await select("项目次任务");
    const screenshotDir = mkdtempSync(
      join(tmpdir(), "codexlike-sidebar-screenshots-")
    );
    console.log(`[e2e:sidebar] 层级截图目录 ${screenshotDir}`);
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
      await neutral();
      await window.screenshot({
        path: join(screenshotDir, `sidebar-${theme}.png`),
      });
      await assertProjectHierarchy(window);
    }
    await window.getByTestId("theme-toggle").click();
    await select("独立B");

    const aId = await item("独立A").getAttribute("data-session-id");
    const bId = await item("独立B").getAttribute("data-session-id");
    const projectId = await window
      .getByTestId("project-header")
      .getAttribute("data-project-id");
    assert(projectId, "项目头暴露稳定项目 ID");
    assert(
      (await window.getByTestId("session-row").count()) === 4,
      "所有活跃行统一 session-row"
    );
    assert(
      (await window.getByTestId("pin-button").count()) === 4,
      "两类会话都有置顶入口"
    );
    for (const id of [
      "session-new",
      "session-archive",
      "session-restore",
      "session-membership",
    ])
      assert(
        (await window.getByTestId(id).count()) === 0,
        `菜单关闭时移除旧顶部入口 ${id}`
      );
    assert(
      await window
        .getByTestId("session-title")
        .evaluate((node) => Number(getComputedStyle(node).fontWeight) >= 600),
      "当前标题使用粗体"
    );

    await neutral();
    for (const time of await window.getByTestId("session-time").all()) {
      assert(await time.isVisible(), "默认显示相对时间");
      assert((await time.textContent()).trim().length > 0, "相对时间非空");
      assert(
        (await time.getAttribute("title")).startsWith("最近使用："),
        "提供绝对时间提示"
      );
    }
    for (const pin of await window.getByTestId("pin-button").all())
      await assertAction(pin, false, "默认置顶不可见且不可命中");
    const header = window.getByTestId("project-header");
    assert(
      (await header.getByTestId("project-session-count").textContent()) === "2",
      "项目显示活跃数量"
    );
    assert(
      (await window
        .getByTestId("standalone-header")
        .getByTestId("project-session-count")
        .textContent()) === "2",
      "独立分区显示活跃数量"
    );
    await assertAction(
      header.getByTestId("project-new-session"),
      false,
      "默认隐藏项目新建"
    );
    await assertAction(
      header.getByTestId("project-remove"),
      false,
      "默认隐藏项目移除"
    );
    await hoverFor(window, item("独立A"));
    await assertAction(
      row(aId).getByTestId("pin-button"),
      true,
      "仅悬浮行显示置顶"
    );
    assert(
      !(await row(aId).getByTestId("session-time").isVisible()),
      "悬浮行隐藏时间"
    );
    await assertAction(
      row(bId).getByTestId("pin-button"),
      false,
      "相邻行不跟随悬浮"
    );
    assert(
      await row(bId).getByTestId("session-time").isVisible(),
      "相邻行仍显示时间"
    );
    await assertAction(
      header.getByTestId("project-new-session"),
      false,
      "行悬浮不展示项目操作"
    );
    await hoverFor(window, header);
    assert(
      !(await header.getByTestId("project-session-count").isVisible()),
      "仅项目头悬浮隐藏计数"
    );
    await assertAction(
      header.getByTestId("project-new-session"),
      true,
      "项目头悬浮展示新建"
    );
    await assertAction(
      header.getByTestId("project-remove"),
      true,
      "项目头悬浮展示移除"
    );
    for (const pin of await window.getByTestId("pin-button").all())
      await assertAction(pin, false, "项目悬浮不展示内部行操作");
    await neutral();
    await item("独立A").focus();
    await assertAction(
      row(aId).getByTestId("pin-button"),
      true,
      "键盘焦点展示置顶"
    );
    assert(
      !(await row(aId).getByTestId("session-time").isVisible()),
      "键盘焦点隐藏时间"
    );
    await window.getByTestId("project-group").focus();
    await assertAction(
      header.getByTestId("project-new-session"),
      true,
      "项目头键盘焦点展示新建"
    );
    await assertAction(
      header.getByTestId("project-remove"),
      true,
      "项目头键盘焦点展示移除"
    );
    assert(
      !(await header.getByTestId("project-session-count").isVisible()),
      "项目头键盘焦点隐藏计数"
    );
    await neutral();

    // 单击任何分区都只是查看，不改变 lastUsedAt 或排序。
    const beforeTimes = await timestamps();
    const projectOrder = await order(project());
    const standaloneOrder = await order(group());
    await select("项目任务");
    assert(
      JSON.stringify(await order(project())) === JSON.stringify(projectOrder),
      "项目内查看不重排"
    );
    await select("独立A");
    assert(
      JSON.stringify(await order(group())) === JSON.stringify(standaloneOrder),
      "独立查看不重排"
    );
    await select("独立B");
    assert(
      JSON.stringify(await timestamps()) === JSON.stringify(beforeTimes),
      "查看不更新最近使用时间"
    );

    // 非当前会话的右键和键盘菜单均绑定目标 ID，不能隐式切换。
    await sessionMenu(window, item("独立A"));
    assert((await currentId()) === bId, "非当前右键不切换");
    assert(
      await menu().evaluate((node) => node.parentElement === document.body),
      "菜单挂载 body portal"
    );
    assert(
      (await row(aId).getByTestId("rename-button").count()) === 0,
      "整理操作不留在行内"
    );
    await assertFocused("session-membership");
    await window.keyboard.press("ArrowUp");
    await assertFocused("archive-button");
    await window.keyboard.press("ArrowDown");
    await assertFocused("session-membership");
    await window.keyboard.press("ArrowDown");
    await assertFocused("rename-button");
    await window.keyboard.press("End");
    await assertFocused("archive-button");
    await window.keyboard.press("Home");
    await assertFocused("session-membership");
    await window.keyboard.press("Escape");
    await menu().waitFor({ state: "detached" });
    assert(
      await item("独立A").evaluate((node) => node === document.activeElement),
      "Escape 焦点返回触发行"
    );
    await item("独立A").press("Shift+F10");
    await menu().waitFor();
    assert(
      (await menu().getAttribute("data-session-id")) === aId &&
        (await currentId()) === bId,
      "Shift+F10 打开目标菜单且不切换"
    );
    await window.keyboard.press("ArrowDown");
    await window.keyboard.press("Enter");
    await window.getByTestId("rename-input").fill("独立A改名");
    await window.getByTestId("rename-input").press("Enter");
    await item("独立A改名").waitFor();
    assert(
      (await currentId()) === bId &&
        (await item("独立A改名").getAttribute("data-session-id")) === aId,
      "键盘重命名只操作非当前目标 ID"
    );
    await action("独立A改名", "rename-button");
    await window.getByTestId("rename-input").fill("独立A");
    await window.getByTestId("rename-input").press("Enter");
    await item("独立A").waitFor();
    await action("独立A", "session-membership");
    await window
      .getByTestId("membership-target")
      .selectOption({ label: "项目" });
    await window.getByTestId("membership-confirm").click();
    await project()
      .getByTestId("session-item")
      .filter({ hasText: "独立A" })
      .waitFor();
    assert(
      (await records()).find((s) => s.id === aId).projectId === projectId &&
        (await currentId()) === bId,
      "非当前移入操作正确 ID 且不切换"
    );
    await action("独立A", "session-membership");
    await window.getByTestId("membership-confirm").click();
    await group()
      .getByTestId("session-item")
      .filter({ hasText: "独立A" })
      .waitFor();
    assert(
      (await records()).find((s) => s.id === aId).projectId === null,
      "非当前移出恢复独立归属"
    );

    // 通过事件携带边缘锚点验证布局钳制；其余菜单路径均真实鼠标/键盘操作。
    const viewport = await window.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    for (const point of [
      { x: 1, y: 1 },
      { x: viewport.width - 1, y: viewport.height - 1 },
    ]) {
      await row(aId).evaluate(
        (node, point) =>
          node.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: point.x,
              clientY: point.y,
            })
          ),
        point
      );
      await menu().waitFor();
      await window
        .waitForFunction(
          () => {
            const node = document.querySelector(
              '[data-testid="session-context-menu"]'
            );
            return (
              node &&
              Number.parseFloat(node.style.left) >= 8 &&
              Number.parseFloat(node.style.top) >= 8
            );
          },
          undefined,
          { timeout: 3000 }
        )
        .catch(async (error) => {
          console.error(
            "[e2e] 菜单布局诊断",
            await menu().evaluate((node) => ({
              style: node.getAttribute("style"),
              rect: node.getBoundingClientRect().toJSON(),
            }))
          );
          throw error;
        });
      const box = await menu().boundingBox();
      assert(
        box.x >= 8 &&
          box.y >= 8 &&
          box.x + box.width <= viewport.width - 8 &&
          box.y + box.height <= viewport.height - 8,
        `边缘菜单完整留在视口内：${JSON.stringify({ box, viewport, point })}`
      );
      await window.keyboard.press("Escape");
    }
    await sessionMenu(window, item("独立A"));
    await window.getByTestId("session-title").click();
    await menu().waitFor({ state: "detached" });
    await sessionMenu(window, item("独立A"));
    await window.getByTestId("composer-input").focus();
    await menu().waitFor({ state: "detached" });
    await sessionMenu(window, item("独立A"));
    await window.getByTestId("message-stream").hover();
    await window.mouse.wheel(0, 100);
    await menu().waitFor({ state: "detached" });
    await sessionMenu(window, item("独立A"));
    await window.keyboard.press("Tab");
    await menu().waitFor({ state: "detached" });
    await sessionMenu(window, item("独立A"));
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const [width, height] = win.getSize();
      win.setSize(width - 20, height - 20);
    });
    await menu().waitFor({ state: "detached" });
    assert((await currentId()) === bId, "取消菜单始终保持原会话");

    await select("项目次任务");
    const projectCurrent = await currentId();
    await action("独立A", "archive-button");
    await item("独立A").waitFor({ state: "detached" });
    assert((await currentId()) === projectCurrent, "非当前归档不切换当前会话");
    await action("独立B", "archive-button");
    await item("独立B").waitFor({ state: "detached" });
    await group().getByTestId("toggle-archived").click();
    const archivedOrder = await order(group(), true);
    const archivedTimes = await timestamps();
    await select("独立A", true);
    await select("独立B", true);
    assert(
      JSON.stringify(await order(group(), true)) ===
        JSON.stringify(archivedOrder),
      "归档查看不重排"
    );
    assert(
      JSON.stringify(await timestamps()) === JSON.stringify(archivedTimes),
      "归档查看不更新时间"
    );
    assert(
      (await window.getByTestId("session-row").count()) === 4,
      "归档与活跃统一行定位"
    );
    assert(
      (await window
        .getByTestId("standalone-header")
        .getByTestId("project-session-count")
        .textContent()) === "0 · 归档 2",
      "计数区分活跃与归档"
    );
    await action("独立A", "unarchive-button", true);
    await item("独立A").waitFor();
    assert(
      (await currentId()) === bId &&
        (await records()).find((s) => s.id === aId).archivedAt === null,
      "非当前恢复只作用于正确 ID"
    );
    await action("独立B", "unarchive-button", true);
    await item("独立B").waitFor();
    assert(
      JSON.stringify(await timestamps()) === JSON.stringify(beforeTimes),
      "整理和菜单不改最近使用时间"
    );

    await hoverClick(window, row(aId).getByTestId("pin-button"), "置顶按钮");
    assert((await order(group()))[0] === aId, "置顶优先");
    await select("独立B");
    assert((await order(group()))[0] === aId, "查看其他会话不越过置顶");
    await hoverClick(window, row(aId).getByTestId("pin-button"), "置顶按钮");
    assert((await order(group()))[0] === bId, "取消置顶恢复最近发送顺序");
    await select("独立A");
    assert((await order(group()))[0] === bId, "查看旧会话不改变顺序");
    await item("独立A").focus();
    await row(aId).getByTestId("pin-button").click();
    await select("独立B");
    await window.getByTestId("project-group").click();
    assert((await item("项目任务").count()) === 0, "折叠隐藏项目会话");
    await action("独立B", "archive-button");
    await item("独立B").waitFor({ state: "detached" });
    await window
      .getByTestId("message-user")
      .filter({ hasText: "独立A" })
      .waitFor();
    if (!(await item("独立B", true).isVisible()))
      await group().getByTestId("toggle-archived").click();
    await select("独立B", true);
    assert(
      await window.getByTestId("composer-send").isDisabled(),
      "归档不能发送，先恢复再发送"
    );
    await action("独立B", "unarchive-button", true);
    await item("独立B").waitFor();
    assert(
      (await group().getByTestId("session-item").count()) === 2,
      "同目录独立会话恢复不归入项目"
    );
    await window.getByTestId("composer-input").fill("/archive");
    await window.getByTestId("composer-send").click();
    await item("独立B").waitFor({ state: "detached" });
    await window
      .getByTestId("message-user")
      .filter({ hasText: "独立A" })
      .waitFor();
    assert(
      readFileSync(marker, "utf8") === "归档不能删除成果",
      "目录成果不删除"
    );
    await closeApp(app);
    app = null;
    ({ app, window } = await launchApp({ homeDir, workspaceDir }));
    await item("独立A").waitFor();
    assert(
      (await window
        .getByTestId("project-group")
        .getAttribute("aria-expanded")) === "false",
      "真正重开保留折叠"
    );
    assert(
      (await row(aId)
        .getByTestId("pin-button")
        .getAttribute("aria-pressed")) === "true",
      "真正重开保留置顶"
    );
    await group().getByTestId("toggle-archived").click();
    await action("独立B", "unarchive-button", true);
    await item("独立B").waitFor();
    await window.getByTestId("project-group").click();
    await select("项目任务");
    await action("项目任务", "archive-button");
    await item("项目任务").waitFor({ state: "detached" });
    await window
      .getByTestId("message-user")
      .filter({ hasText: "独立A" })
      .waitFor();
    await project().getByTestId("toggle-archived").click();
    await action("项目任务", "unarchive-button", true);
    await project()
      .getByTestId("session-item")
      .filter({ hasText: "项目任务" })
      .waitFor();
    assert(
      model.requestCount() === 4,
      "整理、查看、恢复与重启均不重放模型请求"
    );
    await select("项目任务");
    const usedBeforeSend = (await records()).find(
      (s) => s.title === "项目任务"
    ).lastUsedAt;
    await window.getByTestId("composer-input").fill("请求问答");
    await window.getByTestId("composer-send").click();
    await window.getByTestId("interaction-panel").waitFor();
    assert(
      (await records()).find((s) => s.title === "项目任务").lastUsedAt >
        usedBeforeSend,
      "发送才更新最近使用时间"
    );
    assert(
      (
        await project().getByTestId("session-item").first().textContent()
      ).includes("项目任务"),
      "发送将项目会话移到最近使用首位"
    );
    const waitingId = await window
      .getByTestId("interaction-panel")
      .getAttribute("data-interaction-id");
    await hoverClick(
      window,
      item("项目任务").locator("..").getByTestId("pin-button"),
      "置顶按钮"
    );
    await window.getByTestId("project-group").click();
    assert(
      (await window
        .getByTestId("interaction-panel")
        .getAttribute("data-interaction-id")) === waitingId,
      "折叠置顶不取消等待请求"
    );
    await window.getByTestId("project-group").click();
    await action("项目任务", "archive-button");
    await window.getByText(/归档失败.*先停止/).waitFor();
    assert(
      (await window
        .getByTestId("interaction-panel")
        .getAttribute("data-interaction-id")) === waitingId,
      "归档拒绝不消费问答"
    );
    await window.getByTestId("question-option-yes").click();
    await window.getByTestId("question-submit").click();
    await window
      .getByTestId("interaction-panel")
      .waitFor({ state: "detached" });
    await window.getByTestId("composer-send").waitFor();
    assert(model.requestCount() === 6, "拒绝归档后原执行仍可正常回答完成");

    await item("独立A").press("Shift+F10");
    await menu().waitFor();
    await window.keyboard.press("Enter");
    const dialog = window.getByTestId("membership-dialog");
    await dialog.waitFor();
    assert(
      await dialog.evaluate((node) => node.contains(document.activeElement)),
      "键盘打开归属弹窗，初始焦点必须位于弹窗内"
    );
    await assertFocused("membership-target");
    await window.keyboard.press("Shift+Tab");
    await assertFocused("membership-confirm");
    await window.keyboard.press("Tab");
    await assertFocused("membership-target");
    await window.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 3000 });
    assert(
      await item("独立A").evaluate((node) => node === document.activeElement),
      "关闭归属弹窗回到非当前触发行"
    );
    assert((await currentId()) !== aId, "键盘弹窗取消不改变当前会话");
    console.log("[e2e] Shift+F10/Enter 归属弹窗初始焦点与 Escape 返回通过");
    // 公开归档 IPC 只加可控等待，仍转发真实宿主处理，不直接改库。
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get("sessions:archive");
      globalThis.sidebarArchiveGate = { release: null, entered: false };
      ipcMain.removeHandler("sessions:archive");
      ipcMain.handle("sessions:archive", async (event, ...args) => {
        ipcMain.removeHandler("sessions:archive");
        ipcMain.handle("sessions:archive", original);
        await new Promise((resolve) => {
          globalThis.sidebarArchiveGate.release = resolve;
          globalThis.sidebarArchiveGate.entered = true;
        });
        return original(event, ...args);
      });
    });
    await action("独立A", "archive-button");
    assert(
      await app.evaluate(() => globalThis.sidebarArchiveGate.entered),
      "真实归档请求进入等待闸门"
    );
    await sessionMenu(window, item("独立A"));
    await app.evaluate(() => globalThis.sidebarArchiveGate.release());
    await item("独立A").waitFor({ state: "detached" });
    await menu().waitFor({ state: "detached", timeout: 3000 });
    assert((await currentId()) !== aId, "异步归档和菜单失效不切换当前会话");
    if (!(await item("独立A", true).isVisible()))
      await group().getByTestId("toggle-archived").click();
    await action("独立A", "unarchive-button", true);
    await item("独立A").waitFor();
    console.log("[e2e] 异步归档中重开菜单，目标行迁移后旧菜单立即失效通过");

    console.log(
      "[e2e] 三类点击稳定排序、时间/计数悬浮与焦点、非当前菜单目标、键盘/边界/外部关闭、归档恢复重开及等待保护通过"
    );
  } finally {
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
