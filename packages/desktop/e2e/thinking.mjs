// E2E 思考档位（票 02，GLOSSARY「思考档位」）：从输入框胶囊选择贯通 IPC 与 agent-core
// 到本地 mock provider 的实际请求 JSON，并验证主任务思考折叠展示与正文隔离、
// 运行中切档只影响下一条消息。
// 场景：
// 1) 五档逐条发送 → 实际 HTTP body 字段符合 spec 契约（auto 无控制字段；
//    low/medium/high = thinking.type=enabled + reasoning_effort；off = disabled）。
// 2) reasoning_content SSE → 思考折叠块出现，与正文隔离，可展开 / 收起。
// 3) 运行中（工具轮回填的第二轮请求前）切档 → 第二轮 body 仍是发送时快照，
//    下一条消息才采用新档位。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  selectComposerOption,
  assert,
  closeApp,
  expandWorkedHistory,
  launchApp,
  prepareDraft,
  startMockProvider,
} from "./helpers.mjs";

/** 五档 → 期望 body 字段（spec 接入契约表） */
const EFFORT_BODIES = [
  ["auto", { thinking: undefined, reasoningEffort: undefined }],
  ["low", { thinking: { type: "enabled" }, reasoningEffort: "low" }],
  ["medium", { thinking: { type: "enabled" }, reasoningEffort: "medium" }],
  ["high", { thinking: { type: "enabled" }, reasoningEffort: "high" }],
  ["off", { thinking: { type: "disabled" }, reasoningEffort: undefined }],
];

/** 允许窄窗口换行，但控件不能相互遮挡或越出 composer / 视口。 */
async function assertToolbarBounds(window) {
  const layout = await window.getByTestId("composer-card").evaluate((card) => {
    const ids = [
      "approval-mode-select",
      "profile-select",
      "thinking-effort-select",
      "composer-skills",
      "composer-send",
    ];
    const rect = card.getBoundingClientRect();
    const controls = ids.map((id) => {
      const node = card.querySelector(`[data-testid="${id}"]`);
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2
      );
      return {
        id,
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        inside:
          box.width > 0 &&
          box.height > 0 &&
          box.left >= Math.max(0, rect.left) &&
          box.right <= Math.min(innerWidth, rect.right) &&
          box.top >= Math.max(0, rect.top) &&
          box.bottom <= Math.min(innerHeight, rect.bottom),
        reachable: hit === node || node.contains(hit),
      };
    });
    return {
      controls,
      order: Array.from(card.querySelectorAll("[data-testid]"))
        .map((node) => node.getAttribute("data-testid"))
        .filter((id) => ids.includes(id)),
      expectedOrder: ids,
      noOverflow: card.scrollWidth <= card.clientWidth + 1,
    };
  });
  assert(
    JSON.stringify(layout.order) === JSON.stringify(layout.expectedOrder),
    "工具栏 DOM 顺序为审批、模型、思考、技能、发送"
  );
  assert(layout.noOverflow, "长模型名称不撑出 composer 横向滚动");
  for (const [index, control] of layout.controls.entries()) {
    assert(
      control.inside && control.reachable,
      `${control.id} 完整可见且可命中`
    );
    for (const other of layout.controls.slice(index + 1)) {
      assert(
        control.right <= other.left ||
          other.right <= control.left ||
          control.bottom <= other.top ||
          other.bottom <= control.top,
        `${control.id} 与 ${other.id} 不重叠`
      );
    }
  }
}

async function assertMenuBounds(menu) {
  assert(
    await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= innerWidth &&
        rect.bottom <= innerHeight &&
        element.scrollWidth <= element.clientWidth + 1
      );
    }),
    "菜单处于视口内且长名称不产生横向溢出"
  );
}

async function assertSelectedBackground(option, message) {
  assert(
    await option.evaluate((element) => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--hover)";
      document.body.append(probe);
      const matches =
        getComputedStyle(element).backgroundColor ===
        getComputedStyle(probe).backgroundColor;
      probe.remove();
      return matches;
    }),
    message
  );
}

async function main() {
  const { server, port, seenBodies } = await startMockProvider(
    (ctx, { index }) => {
      // 场景 1+2：每条消息一轮文本（场景 2 的第 6 个请求返回 reasoning + 正文）
      if (index === 6) {
        ctx.send({
          delta: { reasoning_content: "先想想怎么回答" },
          finish_reason: null,
        });
        ctx.send({
          delta: { reasoning_content: "再核对一遍" },
          finish_reason: null,
        });
        ctx.send({ delta: { content: "这是正文回答" }, finish_reason: null });
        setTimeout(() => ctx.finishWith("stop"), 30);
        return;
      }
      // 场景 3：第 7 个请求返回工具调用（read_file 预置文件），第 8 个请求收尾文本
      if (index === 7) {
        ctx.toolCallRound("call-thinking", "read_file", { path: "note.txt" });
        return;
      }
      ctx.textRound("收到");
    }
  );
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-thinking-"));
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);
  // 场景 3 的工具调用目标：工作区内预置文件（read_file 真实执行）
  writeFileSync(join(workspaceDir, "note.txt"), "思考档位 e2e 预置内容");

  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    let window = first.window;

    // 无任务时两个选择器必须保持禁用，不因键盘触发弹出菜单。
    for (const testId of ["approval-mode-select", "thinking-effort-select"]) {
      const trigger = window.getByTestId(testId);
      await trigger.waitFor();
      assert(await trigger.isDisabled(), `${testId} 无任务时禁用`);
      assert(
        (await trigger.getAttribute("aria-expanded")) === "false",
        "禁用时没有展开菜单"
      );
    }

    const profileSelect = window.getByTestId("profile-select");
    assert(
      (await profileSelect.textContent()).includes("未配置模型") &&
        (await profileSelect.getAttribute("data-value")) === "",
      "无 Profile 时保留未配置模型占位与空值"
    );

    // 准备：设置页创建 Profile（baseURL 指向本地 mock）→ 新建任务
    await window.getByTestId("settings-open").click();
    await window.getByTestId("profile-create").click();
    const profileForm = window.locator("form");
    await profileForm.getByLabel("名称").fill("Mock");
    await profileForm.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel("API Key").fill("sk-e2e");
    await profileForm.getByLabel("模型").fill("mock-model");
    await window
      .locator("form")
      .getByRole("button", { name: /保存|创建/ })
      .click();
    await window.getByText("Mock").first().waitFor();
    const longProfileName = `长名称模型-${"LongProfileName".repeat(12)}`;
    const longModelName = `mock-${"long-model-name-".repeat(12)}`;
    await window.getByTestId("profile-create").click();
    await profileForm.getByLabel("名称").fill(longProfileName);
    await profileForm.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
    await profileForm.getByLabel("API Key").fill("sk-e2e-long");
    await profileForm.getByLabel("模型").fill(longModelName);
    await profileForm.getByRole("button", { name: /保存|创建/ }).click();
    await window.getByText(longProfileName, { exact: true }).waitFor();
    const profiles = await window.evaluate(() =>
      window.codexlike.providerProfiles.list()
    );
    const mockProfileId = profiles.find((p) => p.name === "Mock")?.id;
    const longProfileId = profiles.find((p) => p.name === longProfileName)?.id;
    assert(mockProfileId && longProfileId, "普通及长名称模型均已创建");
    await window.getByTestId("settings-back").click();
    await prepareDraft(window);
    await selectComposerOption(window, "profile-select", mockProfileId);

    const effortSelect = window.getByTestId("thinking-effort-select");
    const profileMenu = window.getByTestId("profile-select-listbox");
    assert(
      (await profileSelect.getAttribute("role")) === "combobox",
      "模型使用共享 combobox 而非原生 select"
    );
    await profileSelect.click();
    await profileMenu.waitFor();
    assert(
      (await profileMenu.getAttribute("role")) === "listbox" &&
        (await profileSelect.getAttribute("aria-controls")) ===
          (await profileMenu.getAttribute("id")) &&
        (await profileMenu.evaluate(
          (el) => el.parentElement === document.body
        )),
      "模型菜单具有关联的 listbox 语义并 portal 到 body"
    );
    assert(
      (await profileMenu.getByRole("option").count()) === 2,
      "模型列表完整"
    );
    const profileBox = await profileSelect.boundingBox();
    const profileMenuBox = await profileMenu.boundingBox();
    assert(
      profileMenuBox.y + profileMenuBox.height <= profileBox.y,
      "模型菜单有空间时优先上展开"
    );
    await profileSelect.press("Escape");
    await profileMenu.waitFor({ state: "hidden" });
    assert(
      await profileSelect.evaluate((el) => el === document.activeElement),
      "Escape 关闭模型菜单并保留触发器焦点"
    );
    await selectComposerOption(window, "profile-select", longProfileId);
    assert(
      (await profileSelect.getAttribute("data-value")) === longProfileId &&
        (await profileSelect.textContent()).includes(longProfileName) &&
        (await profileSelect.textContent()).includes(longModelName),
      "鼠标提交模型 ID，触发器保留完整名称文本"
    );
    await profileSelect.press("ArrowUp");
    await profileSelect.press("Home");
    assert(
      (await profileSelect.getAttribute("data-value")) === longProfileId,
      "模型键盘导航不提前提交"
    );
    await profileSelect.press("Enter");
    await profileMenu.waitFor({ state: "hidden" });
    assert(
      (await profileSelect.getAttribute("data-value")) === mockProfileId,
      "Home + Enter 提交首个模型"
    );
    await profileSelect.press("Space");
    await profileSelect.press("End");
    await profileSelect.press("Space");
    assert(
      (await profileSelect.getAttribute("data-value")) === longProfileId,
      "End + Space 提交末个模型"
    );
    await profileSelect.press("ArrowDown");
    await profileSelect.press("ArrowUp");
    await profileSelect.press("Enter");
    assert(
      (await profileSelect.getAttribute("data-value")) === mockProfileId,
      "方向键可切回前一个模型"
    );
    await profileSelect.press("Enter");
    await profileSelect.press("ArrowDown");
    await profileSelect.press("Escape");
    assert(
      (await profileSelect.getAttribute("data-value")) === mockProfileId,
      "Escape 取消未提交的模型导航"
    );
    await profileSelect.click();
    await profileSelect.press("Tab");
    await profileMenu.waitFor({ state: "hidden" });
    assert(
      await effortSelect.evaluate((el) => el === document.activeElement),
      "模型 Tab 关闭菜单并前进到思考档位"
    );
    await profileSelect.click();
    await profileSelect.press("Shift+Tab");
    await profileMenu.waitFor({ state: "hidden" });
    assert(
      await window
        .getByTestId("approval-mode-select")
        .evaluate((el) => el === document.activeElement),
      "模型 Shift+Tab 回到审批模式"
    );
    await profileSelect.click();
    // 上展开的长模型菜单可能覆盖输入区，改点菜单外同排的审批触发器。
    const approvalSelect = window.getByTestId("approval-mode-select");
    await approvalSelect.click();
    await profileMenu.waitFor({ state: "hidden" });
    assert(
      await approvalSelect.evaluate((el) => el === document.activeElement),
      "模型菜单外点关闭不抢走审批触发器焦点"
    );
    await approvalSelect.press("Escape");
    await window
      .getByTestId("approval-mode-select-listbox")
      .waitFor({ state: "hidden" });
    await assertToolbarBounds(window);
    await window.getByTestId("composer-input").fill("仅验证工具栏焦点，不发送");
    await effortSelect.focus();
    await effortSelect.press("Tab");
    await window.keyboard.press("Tab");
    assert(
      await window
        .getByTestId("composer-send")
        .evaluate((el) => el === document.activeElement),
      "思考之后依次 Tab 到技能和发送"
    );
    await window.getByTestId("composer-input").fill("");
    assert(
      (await effortSelect.getAttribute("role")) === "combobox",
      "思考档位应使用共享 combobox 触发器，而非原生 select"
    );
    await effortSelect.click();
    const effortMenu = window.getByTestId("thinking-effort-select-listbox");
    await effortMenu.waitFor();
    assert(
      await effortMenu.evaluate(
        (element) => element.parentElement === document.body
      ),
      "思考档位菜单应通过 portal 挂在 body，避免被 composer 裁切"
    );
    assert(
      (await effortMenu.getAttribute("role")) === "listbox",
      "菜单暴露 listbox 语义"
    );
    assert(
      (await effortMenu.getByRole("option").count()) === 5,
      "思考档位保留五个选项"
    );
    const menuBox = await effortMenu.boundingBox();
    const triggerBox = await effortSelect.boundingBox();
    assert(
      menuBox.y + menuBox.height <= triggerBox.y,
      "菜单有空间时优先上展开"
    );
    await effortSelect.press("Escape");
    await effortMenu.waitFor({ state: "hidden" });
    assert(
      await effortSelect.evaluate(
        (element) => element === document.activeElement
      ),
      "Escape 保留触发器焦点"
    );
    await effortSelect.press("ArrowDown");
    await effortSelect.press("End");
    assert(
      (await effortSelect.getAttribute("data-value")) === "auto",
      "方向导航不提前提交"
    );
    await effortSelect.press("Enter");
    assert(
      (await effortSelect.getAttribute("data-value")) === "off",
      "End + Enter 选择末项"
    );
    await effortSelect.press("Space");
    await effortSelect.press("Home");
    await effortSelect.press("ArrowDown");
    await effortSelect.press("Space");
    assert(
      (await effortSelect.getAttribute("data-value")) === "low",
      "Home / ArrowDown / Space 选择低档"
    );
    await effortSelect.press("ArrowUp");
    await effortSelect.press("ArrowUp");
    await effortSelect.press("Enter");
    assert(
      (await effortSelect.getAttribute("data-value")) === "auto",
      "ArrowUp 可返回自动档"
    );
    await effortSelect.press("Enter");
    await effortSelect.press("Tab");
    await effortMenu.waitFor({ state: "hidden" });
    assert(
      await window
        .getByTestId("composer-skills")
        .evaluate((element) => element === document.activeElement),
      "Tab 关闭并前进到下一控件"
    );
    await effortSelect.click();
    await effortSelect.press("Shift+Tab");
    await effortMenu.waitFor({ state: "hidden" });
    assert(
      await profileSelect.evaluate(
        (element) => element === document.activeElement
      ),
      "思考 Shift+Tab 关闭菜单并回到模型选择器"
    );
    await effortSelect.click();
    await window.getByTestId("composer-input").click();
    await effortMenu.waitFor({ state: "hidden" });
    assert(
      await window
        .getByTestId("composer-input")
        .evaluate((element) => element === document.activeElement),
      "外点关闭不能抢走输入框焦点"
    );

    const screenshots = mkdtempSync(
      join(tmpdir(), "codexlike-composer-select-screenshots-")
    );
    console.log(`[e2e:thinking] 选择菜单截图目录 ${screenshots}`);
    for (const theme of ["light", "dark"]) {
      const currentTheme = await window.evaluate(
        () => document.documentElement.dataset.theme ?? "light"
      );
      if (currentTheme !== theme)
        await window.getByTestId("theme-toggle").click();
      await window.waitForFunction(
        (expected) =>
          (document.documentElement.dataset.theme ?? "light") === expected,
        theme
      );
      const selections = [
        ...EFFORT_BODIES.map(([effort]) => ["thinking-effort-select", effort]),
        ["profile-select", mockProfileId],
        ["profile-select", longProfileId],
      ];
      for (const [testId, value] of selections) {
        await selectComposerOption(window, testId, value);
        await window.getByTestId("composer-input").hover();
        const colors = await window.getByTestId(testId).evaluate((element) => {
          const probe = document.createElement("div");
          probe.style.color = "var(--fg-muted)";
          probe.style.backgroundColor = "var(--surface-muted)";
          document.body.append(probe);
          const actual = getComputedStyle(element);
          const expected = getComputedStyle(probe);
          const result = {
            text: actual.color === expected.color,
            background: actual.backgroundColor === expected.backgroundColor,
            icon:
              getComputedStyle(element.querySelector("svg")).color ===
              expected.color,
            radius: parseFloat(actual.borderRadius),
            height: element.getBoundingClientRect().height,
          };
          probe.remove();
          return result;
        });
        assert(
          colors.text && colors.icon && colors.background,
          `${theme} ${testId} ${value} 使用中性文字、图标、底色`
        );
        assert(
          colors.radius > 0 && colors.radius < colors.height / 2,
          "触发器使用小圆角而非胶囊"
        );
      }
      await effortSelect.click();
      const selection = effortMenu.getByRole("option", { selected: true });
      assert(
        (await selection.getAttribute("data-value")) === "off",
        "选中态跟随受控值"
      );
      await assertSelectedBackground(selection, "选中行使用中性淡底色");
      assert(
        await selection.locator("svg").last().isVisible(),
        "选中行显示勾选标记"
      );
      await window.screenshot({
        path: join(screenshots, `thinking-menu-${theme}.png`),
      });
      await effortSelect.press("Escape");
      await assertToolbarBounds(window);
      await profileSelect.click();
      await profileMenu.waitFor();
      const selectedProfile = profileMenu.getByRole("option", {
        selected: true,
      });
      assert(
        (await selectedProfile.getAttribute("data-value")) === longProfileId &&
          (await selectedProfile.textContent()).includes(longProfileName) &&
          (await selectedProfile.textContent()).includes(longModelName),
        "模型选中态与完整长名称跟随受控值"
      );
      assert(
        await profileMenu.evaluate((element) => {
          const probe = document.createElement("div");
          probe.style.backgroundColor = "var(--surface)";
          probe.style.color = "var(--fg-muted)";
          probe.style.borderColor = "var(--line)";
          document.body.append(probe);
          const actual = getComputedStyle(element);
          const expected = getComputedStyle(probe);
          const matches =
            actual.backgroundColor === expected.backgroundColor &&
            actual.color === expected.color &&
            actual.borderTopColor === expected.borderTopColor;
          probe.remove();
          return matches;
        }),
        `${theme} 模型菜单背景、文字、边框遵循语义主题`
      );
      await assertSelectedBackground(
        selectedProfile,
        `${theme} 模型选中行使用中性淡底色`
      );
      assert(
        await selectedProfile.locator("svg").last().isVisible(),
        "模型选中行显示勾选标记"
      );
      await assertMenuBounds(profileMenu);
      await window.screenshot({
        path: join(screenshots, `profile-menu-${theme}.png`),
      });
      await profileSelect.press("Escape");
    }
    await window.getByTestId("theme-toggle").click();
    const originalSize = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getContentSize()
    );
    // Electron content size 用于恢复宿主窗口；DOM viewport 单独记录，
    // 不假定两者在不同窗口边框、菜单栏或缩放配置下必然相等。
    const originalViewport = await window.evaluate(() => [
      innerWidth,
      innerHeight,
    ]);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(640, 500)
    );
    try {
      await window.waitForFunction(
        () =>
          Math.abs(innerWidth - 640) <= 2 && Math.abs(innerHeight - 500) <= 2,
        null,
        { timeout: 5000 }
      );
    } catch (error) {
      console.error(
        "[e2e:thinking] 窄窗口实际尺寸",
        await window.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          ratio: devicePixelRatio,
        }))
      );
      throw error;
    }
    for (const theme of ["light", "dark"]) {
      const currentTheme = await window.evaluate(
        () => document.documentElement.dataset.theme ?? "light"
      );
      if (currentTheme !== theme)
        await window.getByTestId("theme-toggle").click();
      await window.waitForFunction(
        (expected) =>
          (document.documentElement.dataset.theme ?? "light") === expected,
        theme
      );
      await assertToolbarBounds(window);
      await profileSelect.click();
      await profileSelect.press("End");
      await profileMenu.waitFor();
      await assertMenuBounds(profileMenu);
      const longOption = profileMenu.getByTestId(
        `profile-select-option-${longProfileId}`
      );
      assert(
        (await profileSelect.getAttribute("aria-activedescendant")) ===
          (await longOption.getAttribute("id")),
        "长名称模型导航的活动项可通过 aria-activedescendant 定位"
      );
      assert(
        await longOption.evaluate((element) => {
          const item = element.getBoundingClientRect();
          const menu = element.parentElement;
          const viewport = menu.getBoundingClientRect();
          const top = viewport.top + menu.clientTop;
          const left = viewport.left + menu.clientLeft;
          return (
            item.top >= top &&
            item.bottom <= top + menu.clientHeight &&
            item.left >= left &&
            item.right <= left + menu.clientWidth
          );
        }),
        "窄矮视口长名称选项完整处于菜单可视区域"
      );
      await window.screenshot({
        path: join(screenshots, `profile-menu-narrow-${theme}.png`),
      });
      await profileSelect.press("Escape");
    }
    await window.getByTestId("theme-toggle").click();
    await effortSelect.click();
    await effortSelect.press("End");
    const bounds = await effortMenu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: innerWidth,
        height: innerHeight,
      };
    });
    assert(
      bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= bounds.width &&
        bounds.bottom <= bounds.height,
      "窄矮视口菜单仍保持在视口内"
    );
    const lastOption = effortMenu.getByTestId(
      "thinking-effort-select-option-off"
    );
    assert(
      (await effortSelect.getAttribute("aria-activedescendant")) ===
        (await lastOption.getAttribute("id")),
      "End 将 combobox 的活动项指向末项"
    );
    assert(
      await lastOption.evaluate((element) => {
        const item = element.getBoundingClientRect();
        const menu = element.parentElement;
        const viewport = menu.getBoundingClientRect();
        const top = viewport.top + menu.clientTop;
        const left = viewport.left + menu.clientLeft;
        return (
          item.top >= top &&
          item.bottom <= top + menu.clientHeight &&
          item.left >= left &&
          item.right <= left + menu.clientWidth
        );
      }),
      "窄矮视口末项矩形完整处于菜单可视范围，未被滚动容器裁切"
    );
    await window.screenshot({
      path: join(screenshots, "thinking-menu-narrow.png"),
    });
    await effortSelect.press("Escape");
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]),
      originalSize
    );
    try {
      await window.waitForFunction(
        ([width, height]) =>
          Math.abs(innerWidth - width) <= 2 &&
          Math.abs(innerHeight - height) <= 2,
        originalViewport,
        { timeout: 5000 }
      );
    } catch (error) {
      const actualSize = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getContentSize()
      );
      const actualViewport = await window.evaluate(() => [
        innerWidth,
        innerHeight,
      ]);
      throw new Error(
        `窗口恢复超时：${JSON.stringify({
          originalSize,
          originalViewport,
          actualSize,
          actualViewport,
        })}`,
        { cause: error }
      );
    }
    await assertToolbarBounds(window);
    await selectComposerOption(window, "profile-select", mockProfileId);
    assert(seenBodies.length === 0, "模型与思考选择、主题切换不自动发送请求");
    await selectComposerOption(window, "thinking-effort-select", "auto");
    // 默认自动，无任务时已被禁用、建任务后可用
    assert(
      (await effortSelect.getAttribute("data-value")) === "auto",
      "思考档位胶囊默认值不是 auto"
    );

    // ---- 场景 1：五档逐条发送 → 实际请求 body 符合契约 ----
    for (let i = 0; i < EFFORT_BODIES.length; i++) {
      const [effort] = EFFORT_BODIES[i];
      await selectComposerOption(window, "thinking-effort-select", effort);
      await window
        .getByTestId("composer-input")
        .fill(`第${i + 1}条：档位 ${effort}`);
      await window.getByTestId("composer-send").click();
      // click 自带 actionability 等待（streaming 中是停止按钮，流结束才恢复发送）；
      // 再等本条请求真正到达 mock 端
      for (let tick = 0; tick < 100 && seenBodies.length < i + 1; tick++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(
        seenBodies.length === i + 1,
        `第${i + 1}条消息（${effort} 档）的请求未到达 mock 端`
      );
    }
    EFFORT_BODIES.forEach(([effort, expected], i) => {
      const body = JSON.parse(seenBodies[i]);
      if (expected.thinking === undefined) {
        assert(
          body.thinking === undefined,
          `${effort} 档不应附加 thinking 字段：${seenBodies[i]}`
        );
      } else {
        assert(
          JSON.stringify(body.thinking) === JSON.stringify(expected.thinking),
          `${effort} 档 body.thinking 不正确：${seenBodies[i]}`
        );
      }
      if (expected.reasoningEffort === undefined) {
        assert(
          body.reasoning_effort === undefined,
          `${effort} 档不应附加 reasoning_effort 字段：${seenBodies[i]}`
        );
      } else {
        assert(
          body.reasoning_effort === expected.reasoningEffort,
          `${effort} 档 body.reasoning_effort 不正确：${seenBodies[i]}`
        );
      }
    });
    console.log("[e2e] 五档胶囊选择 → 实际请求 JSON 字段全部符合契约");

    // ---- 场景 2：reasoning SSE → 折叠展示、与正文隔离、可展开 / 收起 ----
    await window.getByTestId("composer-input").fill("带思考的回答");
    await window.getByTestId("composer-send").click();
    // 等第 6 个请求（含 reasoning SSE）到达 mock 端，再断言 UI 展示
    for (let tick = 0; tick < 100 && seenBodies.length < 6; tick++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(seenBodies.length === 6, `预期 6 个请求，实际 ${seenBodies.length}`);

    // 票 04：轮完成后思考段收进该轮「已工作折叠区」（默认收起），
    // 先展开折叠区再交互；thinking 折叠块自身的默认收起/展开断言不变
    await window.getByTestId("worked-history-toggle").click();
    await window.getByTestId("worked-history-items").waitFor();
    const thinkingBlock = window.getByTestId("thinking-block").first();
    await thinkingBlock.waitFor({ timeout: 20_000 });
    // 默认收起：思考内容不可见
    const thinkingContent = thinkingBlock.getByTestId("thinking-content");
    assert(
      !(await thinkingContent.isVisible()),
      "思考块应默认收起（内容不可见）"
    );
    // 展开可见思考内容
    await thinkingBlock.getByTestId("thinking-toggle").click();
    await thinkingContent.waitFor({ timeout: 10_000 });
    const thinkingText = await thinkingContent.textContent();
    assert(
      thinkingText !== null &&
        thinkingText.includes("先想想怎么回答") &&
        thinkingText.includes("再核对一遍") &&
        !thinkingText.includes("这是正文回答"),
      `思考内容不完整或混入正文：${thinkingText ?? "(空)"}`
    );
    // 正文区（与思考折叠块同气泡但独立渲染）：含正文、不含思考
    const assistantBubbles = window.getByTestId("message-assistant");
    const lastIndex = (await assistantBubbles.count()) - 1;
    const bubbleText = await assistantBubbles
      .nth(lastIndex)
      .getByTestId("assistant-content")
      .textContent();
    assert(
      bubbleText !== null && bubbleText.includes("这是正文回答"),
      "正文回答未出现在助手气泡"
    );
    assert(
      bubbleText !== null && !bubbleText.includes("先想想怎么回答"),
      "思考内容混入了正文气泡"
    );
    // 收起后内容再次不可见
    await thinkingBlock.getByTestId("thinking-toggle").click();
    assert(!(await thinkingContent.isVisible()), "点击收起后思考内容应不可见");
    console.log("[e2e] reasoning 流：折叠块与正文隔离，可展开 / 收起");

    // ---- 场景 3：运行中切档只影响下一条消息 ----
    // 发送 medium 档消息：第 1 轮工具调用 →（运行中把胶囊切到 off）→
    // 回填后的第 2 轮请求仍应是 medium 快照；下一条消息才用 off
    await selectComposerOption(window, "thinking-effort-select", "medium");
    await window.getByTestId("composer-input").fill("读一下 note.txt");
    await window.getByTestId("composer-send").click();
    // 工具调用轮（第 7 个请求）到达 mock 即切档（为下一条消息预置）。
    // 档位在发送时快照、运行中切换不影响本轮；read_file 卡片断言不依赖
    // 运行中的短暂可见窗口（票 04：轮完成即收进折叠区），改在完成后展开回看。
    // 工具往返可能快于轮询粒度（醒来时第 8 个请求已发），以 >=7 为准
    for (let i = 0; i < 100 && seenBodies.length < 7; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(
      seenBodies.length >= 7,
      `第 7 个请求（工具调用轮）未到达 mock，实际 ${seenBodies.length}`
    );
    await selectComposerOption(window, "thinking-effort-select", "off");
    // 等本轮全部请求到达：第 8 个请求（工具回填后的最终文本轮）才是快照断言对象
    for (let i = 0; i < 100 && seenBodies.length < 8; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(seenBodies.length === 8, `预期 8 个请求，实际 ${seenBodies.length}`);
    // 等最终文本回复渲染（本轮结束；最终正文在折叠区外，收起也可见）
    await window
      .getByTestId("message-assistant")
      .nth(6)
      .waitFor({ timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 300));
    // 轮完成后工具卡收进已工作折叠区：展开回看，read_file 卡仍完整（票 04）
    await expandWorkedHistory(window, 1);
    const restoredToolCard = window.getByTestId("tool-call-card").first();
    await restoredToolCard.waitFor({ timeout: 10_000 });
    assert(
      (await restoredToolCard.getAttribute("data-tool-name")) === "read_file",
      "本轮 read_file 工具卡片应存在（展开回看完整）"
    );
    await new Promise((r) => setTimeout(r, 300));
    const secondRound = JSON.parse(seenBodies[7]);
    assert(
      secondRound.thinking !== undefined &&
        secondRound.thinking.type === "enabled" &&
        secondRound.reasoning_effort === "medium",
      `运行中切档不应影响本轮：第 2 轮请求应为 medium 快照，实际 ${seenBodies[7]}`
    );
    // 下一条消息采用新档位 off
    await window.getByTestId("composer-input").fill("新档位消息");
    await window.getByTestId("composer-send").click();
    for (let i = 0; i < 100 && seenBodies.length < 9; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(seenBodies.length === 9, `预期 9 个请求，实际 ${seenBodies.length}`);
    const nextMessage = JSON.parse(seenBodies[8]);
    assert(
      nextMessage.thinking !== undefined &&
        nextMessage.thinking.type === "disabled",
      `下一条消息应采用新档位 off：${seenBodies[8]}`
    );
    assert(
      nextMessage.reasoning_effort === undefined,
      "off 档不应附加 reasoning_effort"
    );
    console.log("[e2e] 运行中切档：本轮保持 medium 快照，下一条消息采用 off");

    // 删除正式任务已保存的模型，不应悄悄回退到首个可用 Profile。
    await window.getByTestId("composer-send").waitFor();
    await selectComposerOption(window, "profile-select", longProfileId);
    await window.getByTestId("settings-open").click();
    const profileRow = window.locator("li").filter({
      has: window.getByText(longProfileName, { exact: true }),
    });
    window.once("dialog", (dialog) => dialog.accept());
    await profileRow.getByRole("button", { name: "删除", exact: true }).click();
    await profileRow.waitFor({ state: "hidden" });
    await window.getByTestId("settings-back").click();
    await profileSelect
      .getByText("已保存的模型不可用", { exact: true })
      .waitFor();
    assert(
      (await profileSelect.getAttribute("data-value")) === longProfileId,
      "失效模型占位保留已保存的 Profile ID"
    );
    await selectComposerOption(window, "profile-select", mockProfileId);
    assert(
      (await profileSelect.getAttribute("data-value")) === mockProfileId,
      "失效模型仍可通过菜单显式改选可用模型"
    );
    assert(seenBodies.length === 9, "删除和重选模型不额外发送请求");

    await closeApp(app);
    console.log("[e2e] 思考档位主任务全链路通过 ✅");
  } catch (error) {
    console.error("[e2e] 思考档位场景失败 ❌", error);
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
