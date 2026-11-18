// 模型与思考统一选择器：新建首发前 / 已有任务的真实 dialog 交互、布局与键盘，
// 贯通 IPC、agent-core 到 mock HTTP；保留五档请求、reasoning 正文隔离和失效模型原值。
// 运行中由 mock 工具轮闸门确保改模型 / 档位发生在回填请求前，验证发送时快照。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import {
  selectComposerOption,
  assert,
  closeApp,
  composerOptionValue,
  launchApp,
  modelOptionValue,
  NARROW_WIDTH,
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
const EFFORT_LABELS = {
  auto: "自动",
  low: "低",
  medium: "中",
  high: "高",
  off: "关",
};

const controls = (window) => {
  const trigger = window.getByTestId("model-thinking-select");
  const dialog = window.getByTestId("model-thinking-popover");
  const models = dialog.getByTestId("model-thinking-models");
  const efforts = dialog.getByTestId("model-thinking-efforts");
  return {
    trigger,
    dialog,
    models,
    efforts,
    provider: dialog.getByTestId("model-thinking-provider"),
    model: (value) =>
      models.getByTestId(`model-thinking-model-option-${value}`),
    effort: (value) => efforts.getByTestId(`model-thinking-effort-${value}`),
  };
};

async function waitSelection(window, value, effort) {
  await window.waitForFunction(
    ({ value, effort }) => {
      const node = document.querySelector(
        '[data-testid="model-thinking-select"]'
      );
      return (
        node?.getAttribute("data-model-value") === value &&
        node?.getAttribute("data-thinking-effort") === effort
      );
    },
    { value, effort }
  );
}

async function assertSelection(window, value, effort, message) {
  assert(
    (await composerOptionValue(window, "profile-select")) === value &&
      (await composerOptionValue(window, "thinking-effort-select")) === effort,
    message
  );
}

async function assertFocus(locator, message) {
  assert(
    await locator.evaluate((node) => node === document.activeElement),
    message
  );
}

/** 几何读取必须跨渲染帧：等 ResizeObserver / rAF 定位完成，不拿一次旧矩形当稳定。 */
async function nextLayoutFrames(window) {
  await window.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })
  );
}

async function layoutSnapshot(window) {
  const ui = controls(window);
  const snapshot = {};
  for (const key of ["trigger", "dialog", "provider", "efforts"]) {
    snapshot[key] = await ui[key].boundingBox();
    assert(snapshot[key], `${key} 必须有真实可见矩形`);
  }
  return snapshot;
}

function sameBox(a, b, keys = ["x", "y", "width", "height"], tolerance = 0.5) {
  return keys.every((key) => Math.abs(a[key] - b[key]) <= tolerance);
}

async function stableLayout(window) {
  const deadline = Date.now() + 5000;
  let previous;
  let consecutive = 0;
  while (Date.now() < deadline) {
    await nextLayoutFrames(window);
    const current = await layoutSnapshot(window);
    consecutive =
      previous &&
      Object.keys(current).every((key) => sameBox(current[key], previous[key]))
        ? consecutive + 1
        : 0;
    if (consecutive >= 3) return current;
    previous = current;
  }
  throw new Error(`统一选择器几何未跨帧稳定：${JSON.stringify(previous)}`);
}

async function assertLockedLayout(window, before, message) {
  const after = await stableLayout(window);
  assert(
    sameBox(before.trigger, after.trigger, ["width"]) &&
      ["dialog", "provider", "efforts"].every((key) =>
        sameBox(before[key], after[key])
      ),
    `${message}：${JSON.stringify({ before, after })}`
  );
  return after;
}

/** 新建态以整页为界，任务态以输入卡为界；模型与思考只占一个工具栏位置。 */
async function assertToolbarBounds(window) {
  const inTaskView = (await window.getByTestId("composer-card").count()) > 0;
  const cardTestid = inTaskView ? "composer-card" : "new-task-start";
  const ids = [
    "approval-mode-select",
    "model-thinking-select",
    ...(inTaskView ? ["composer-skills"] : []),
    "composer-send",
  ];
  const layout = await window.getByTestId(cardTestid).evaluate((card, ids) => {
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
      noOverflow: card.scrollWidth <= card.clientWidth + 1,
    };
  }, ids);
  assert(
    JSON.stringify(layout.order) === JSON.stringify(ids),
    "工具栏顺序为审批、统一模型与思考、技能（任务态）、发送"
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

async function assertMenuBounds(window) {
  const { dialog, provider, efforts } = controls(window);
  assert(
    await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= innerWidth + 1 &&
        rect.bottom <= innerHeight + 1 &&
        // 绝对宽度上限：弹层是内容面板不是全屏层——首测锁定若把无宽度约束的
        // portal 块级元素撑满视口（真实缺陷，曾漏过只比前后一致的锁定断言），
        // 这里直接拦下。220 内容宽 + 边距容差。
        rect.width <= 240 &&
        element.scrollWidth <= element.clientWidth + 1
      );
    }),
    "dialog 处于视口内、宽度为内容面板级（≤360px）且长名称不产生横向溢出"
  );
  for (const locator of [
    provider,
    ...(await efforts.getByRole("button").all()),
  ]) {
    assert(
      await locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2
        );
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.top >= 0 &&
          rect.bottom <= innerHeight + 1 &&
          (element === hit || element.contains(hit))
        );
      }),
      "提供商与五档在 dialog 内可见、可命中，不被模型滚动区盖住"
    );
  }
}

async function assertModelVisible(option) {
  const geometry = await option.evaluate((element) => {
    const list = element.closest('[data-testid="model-thinking-models"]');
    const item = element.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    return {
      ok:
        item.top >= viewport.top + list.clientTop - 1 &&
        item.bottom <= viewport.top + list.clientTop + list.clientHeight + 1 &&
        item.left >= viewport.left - 1 &&
        item.right <= viewport.right + 1,
      item: {
        top: item.top,
        bottom: item.bottom,
        left: item.left,
        right: item.right,
      },
      viewport: {
        top: viewport.top,
        clientTop: list.clientTop,
        clientHeight: list.clientHeight,
        scrollTop: list.scrollTop,
        scrollHeight: list.scrollHeight,
        left: viewport.left,
        right: viewport.right,
      },
    };
  });
  assert(
    geometry.ok,
    `选中或键盘活动模型完整处于模型列表可视区域：${JSON.stringify(geometry)}`
  );
}

/** 读取主题 token 后在 Node 归一颜色，不向 DOM 插入探针或修改业务状态。 */
function color(value) {
  const trimmed = value.trim().toLowerCase();
  // 3 位短格式（#fff）先展开为 6 位，再统一转 rgb()/rgba() 比较；
  // 8 位（#rrggbbaa）带 alpha，与 computed 的 rgba() 输出对齐（alpha 取 2 位小数）。
  const expanded = /^#[0-9a-f]{3}$/.test(trimmed)
    ? `#${trimmed
        .slice(1)
        .split("")
        .map((char) => char + char)
        .join("")}`
    : trimmed;
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(expanded);
  if (hex) {
    const [r, g, b] = [1, 3, 5].map((offset) =>
      parseInt(expanded.slice(offset, offset + 2), 16)
    );
    if (hex[2] !== undefined) {
      const alpha = Math.round((parseInt(hex[2], 16) / 255) * 100) / 100;
      return `rgba(${r},${g},${b},${alpha})`;
    }
    return `rgb(${r},${g},${b})`;
  }
  // computed rgba/rgb 里的 alpha 也取 2 位小数，避免 0.058823… 与 0.06 的字面差
  return trimmed
    .replaceAll(" ", "")
    .replace(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/, (_m, r, g, b, a) =>
      Number.isInteger(Number(a))
        ? `rgba(${r},${g},${b},${a})`
        : `rgba(${r},${g},${b},${Math.round(Number(a) * 100) / 100})`
    );
}

async function assertThemeColor(locator, pairs, message) {
  const matches = await locator.evaluate((element, pairs) => {
    const actual = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    return pairs.map(([property, token]) => [
      actual[property],
      root.getPropertyValue(token),
    ]);
  }, pairs);
  assert(
    matches.every(([actual, expected]) => color(actual) === color(expected)),
    `${message}：${JSON.stringify(matches)}`
  );
}

async function selectModelInDialog(window, value, effort) {
  const ui = controls(window);
  await ui.model(value).click();
  await waitSelection(window, value, effort);
  assert(await ui.dialog.isVisible(), "选择模型即时保存二元组且不关闭 dialog");
  assert(
    (await ui.model(value).getAttribute("aria-pressed")) === "true",
    "模型按钮选中态跟随受控二元组"
  );
}

/** 两个真实入口共用验收，但不走会用 Escape 收尾的通用选择 helper。 */
async function assertDialogInteractions(window, fixture, label) {
  const {
    mockProfileId,
    longProfileId,
    longProfileName,
    longModelName,
    longModels,
  } = fixture;
  const mockValue = modelOptionValue(mockProfileId, "mock-model");
  const shortValue = modelOptionValue(longProfileId, longModels[0]);
  const longValue = modelOptionValue(longProfileId, longModelName);
  const ui = controls(window);
  await ui.trigger.click();
  await ui.dialog.waitFor();
  assert(
    (await ui.trigger.getAttribute("aria-haspopup")) === "dialog" &&
      (await ui.trigger.getAttribute("aria-expanded")) === "true" &&
      (await ui.trigger.getAttribute("aria-controls")) ===
        (await ui.dialog.getAttribute("id")) &&
      (await ui.dialog.getAttribute("role")) === "dialog" &&
      (await ui.dialog.getAttribute("aria-label")) === "模型与思考" &&
      (await ui.dialog.evaluate(
        (node) => node.parentElement === document.body
      )),
    `${label} 统一 trigger 关联 portal dialog`
  );
  assert(
    await ui.provider.evaluate((node) => node.tagName === "SELECT"),
    "Provider 保留原生 select"
  );
  for (const [group, name] of [
    [ui.models, "模型"],
    [ui.efforts, "思考档位"],
  ]) {
    assert(
      (await group.getAttribute("role")) === "group" &&
        (await group.getAttribute("aria-label")) === name,
      `${name} 使用独立有名 group`
    );
  }
  assert(
    (await ui.provider.inputValue()) === mockProfileId,
    `${label} 重开定位到已选模型所属 Profile`
  );
  assert(
    (await ui.models.getByRole("button").count()) === 1,
    "模型按钮只呈现当前 Profile，不把原生 option 当模型列表"
  );
  assert(
    (await ui.efforts.getByRole("button").count()) === 5,
    "统一 dialog 保留五档，不按模型能力隐藏"
  );
  const initial = await stableLayout(window);
  await ui.provider.selectOption(longProfileId);
  assert(
    (await ui.models.getByRole("button").count()) === longModels.length,
    "切换提供商显示该 Profile 的完整长模型列表"
  );
  assert(
    (await ui.model(mockValue).count()) === 0,
    "筛选后不残留其他提供商模型按钮"
  );
  await assertSelection(
    window,
    mockValue,
    "auto",
    `${label} 提供商只筛选，不保存模型或档位`
  );
  await assertLockedLayout(
    window,
    initial,
    `${label} 单模型切长列表时弹层 xywh / 提供商 / 档位及 trigger 宽度不跳`
  );
  await ui.model(shortValue).focus();
  await window.keyboard.press("Escape");
  await ui.dialog.waitFor({ state: "hidden" });
  await ui.trigger.click();
  assert(
    (await ui.provider.inputValue()) === mockProfileId,
    `${label} 关闭筛选后重开仍回已保存 Profile`
  );
  await assertSelection(
    window,
    mockValue,
    "auto",
    `${label} 只浏览 Profile 后 Escape 不产生保存`
  );

  const locked = await stableLayout(window);
  await ui.provider.selectOption(longProfileId);
  await selectModelInDialog(window, shortValue, "auto");
  await assertLockedLayout(window, locked, `${label} 短模型保存后保持布局`);
  await ui.model(shortValue).press("End");
  await assertFocus(ui.model(longValue), "模型 End 移动真实焦点到末模型");
  await assertModelVisible(ui.model(longValue));
  await assertSelection(
    window,
    shortValue,
    "auto",
    "模型 End 只导航，不提前提交"
  );
  await window.keyboard.press("Enter");
  await waitSelection(window, longValue, "auto");
  assert(await ui.dialog.isVisible(), "模型 Enter 保存后 dialog 继续打开");
  await assertLockedLayout(
    window,
    locked,
    `${label} 同次打开短模型切超长模型，弹层 xywh / trigger 宽度不跳`
  );
  const title = await ui.trigger.getAttribute("title");
  assert(
    title.includes(longProfileName) && title.includes(longModelName),
    "收起 trigger 的 title 保留 Profile 与完整长模型名"
  );
  assert(
    (await ui.trigger.textContent()).includes(longModelName) &&
      (await ui.trigger.textContent()).includes("自动"),
    "trigger 显示模型名与当前档位"
  );
  await window.keyboard.press("Home");
  await window.keyboard.press("ArrowDown");
  await assertFocus(
    ui.model(modelOptionValue(longProfileId, longModels[1])),
    "模型 Home / ArrowDown 导航到第二项"
  );
  await window.keyboard.press("ArrowUp");
  await assertFocus(ui.model(shortValue), "模型 ArrowUp 回到第一项");
  await assertSelection(window, longValue, "auto", "模型方向键不提前保存");
  await window.keyboard.press("Space");
  await waitSelection(window, shortValue, "auto");
  assert(await ui.dialog.isVisible(), "模型 Space 保存且不关闭");
  await assertLockedLayout(window, locked, `${label} 长模型切回短模型同样不跳`);
  await window.keyboard.press("End");
  await window.keyboard.press("Space");
  await waitSelection(window, longValue, "auto");
  await assertLockedLayout(window, locked, `${label} 再次切长模型布局仍锁定`);

  // 真实滚轮只滚模型区：提供商和五档底栏的矩形固定，dialog 不整体滚动。
  assert(
    await ui.models.evaluate((node) => node.scrollHeight > node.clientHeight),
    "长模型列表确实需要滚动"
  );
  const beforeScroll = await stableLayout(window);
  const bottom = await ui.models.evaluate((node) => node.scrollTop);
  await ui.models.hover();
  await window.mouse.wheel(0, -10000);
  await window.waitForFunction(
    (before) =>
      document.querySelector('[data-testid="model-thinking-models"]')
        .scrollTop < before,
    bottom
  );
  await assertLockedLayout(
    window,
    beforeScroll,
    "滚动长列表时提供商与档位条固定"
  );
  await assertMenuBounds(window);
  await window.keyboard.press("Escape");
  await ui.dialog.waitFor({ state: "hidden" });
  await assertFocus(ui.trigger, "模型 Escape 关闭并恢复 trigger 焦点");
  await assertSelection(
    window,
    longValue,
    "auto",
    "Escape 不撤销已经保存的长模型"
  );
  await ui.trigger.click();
  await assertFocus(ui.model(longValue), "重开聚焦已选模型而不是首模型");
  await nextLayoutFrames(window);
  await assertModelVisible(ui.model(longValue));

  // Provider 保留原生按键处理；焦点不能被冒充旧 combobox 的父级快捷键劫持。
  await window.keyboard.press("Shift+Tab");
  await assertFocus(ui.provider, "模型 Shift+Tab 到提供商");
  await ui.provider.press("Home");
  assert(
    (await ui.provider.inputValue()) === mockProfileId,
    "Provider Home 走原生筛选"
  );
  await ui.provider.press("End");
  assert(
    (await ui.provider.inputValue()) === longProfileId,
    "Provider End 走原生筛选"
  );
  await ui.provider.press("ArrowUp");
  assert(
    (await ui.provider.inputValue()) === mockProfileId,
    "Provider ArrowUp 只改变浏览提供商"
  );
  await ui.provider.press("ArrowDown");
  assert(
    (await ui.provider.inputValue()) === longProfileId,
    "Provider ArrowDown 可切回长列表"
  );
  await assertSelection(
    window,
    longValue,
    "auto",
    "Provider 原生键盘导航不保存模型或档位"
  );
  await assertFocus(ui.provider, "Provider 原生导航后焦点仍在 select");
  // Provider 上的单次 Escape 先服务原生 select 语义，不能直接关掉主弹层
  //（连续 Esc 是否逐步关闭属 UI 后续决策，这里只锁死「一次 Esc 不等于关闭」）。
  await ui.provider.press("Escape");
  assert(
    await ui.dialog.isVisible(),
    "Provider 单次 Escape 不关闭主弹层，保留原生语义"
  );
  await ui.provider.press("Tab");
  await assertFocus(ui.model(longValue), "Provider Tab 到当前模型");
  await window.keyboard.press("Tab");
  await assertFocus(ui.effort("auto"), "模型 Tab 到当前档位组");
  await window.keyboard.press("End");
  await assertFocus(ui.effort("off"), "档位 End 到关");
  await window.keyboard.press("Home");
  await window.keyboard.press("ArrowRight");
  await assertFocus(ui.effort("low"), "档位 Home / ArrowRight 到低");
  await window.keyboard.press("ArrowLeft");
  await assertFocus(ui.effort("auto"), "档位 ArrowLeft 返回自动");
  await assertSelection(
    window,
    longValue,
    "auto",
    "档位方向 / Home / End 只导航不提交"
  );
  await window.keyboard.press("End");
  await window.keyboard.press("Enter");
  await ui.dialog.waitFor({ state: "hidden" });
  await waitSelection(window, longValue, "off");
  await assertFocus(ui.trigger, "档位 Enter 即时保存、关闭并归还焦点");

  await ui.trigger.click();
  await window.keyboard.press("Shift+Tab");
  await assertFocus(ui.provider, "重开后模型 Shift+Tab 到 Provider");
  await window.keyboard.press("Shift+Tab");
  await ui.dialog.waitFor({ state: "hidden" });
  await assertFocus(ui.trigger, "Provider Shift+Tab 关闭并返回 trigger");
  await ui.trigger.click();
  await window.keyboard.press("Tab");
  await assertFocus(ui.effort("off"), "模型 Tab 到已保存的关档");
  await window.keyboard.press("Shift+Tab");
  await assertFocus(ui.model(longValue), "档位 Shift+Tab 回模型");
  await window.keyboard.press("Tab");
  await window.keyboard.press("Tab");
  await ui.dialog.waitFor({ state: "hidden" });
  const nextControl =
    (await window.getByTestId("composer-skills").count()) > 0
      ? window.getByTestId("composer-skills")
      : window.getByTestId("composer-input");
  await assertFocus(
    nextControl,
    "档位 Tab 关闭并前进到 trigger 后的真实页面控件"
  );
  await assertSelection(window, longValue, "off", "Tab 离开不误提交导航值");

  await ui.trigger.click();
  await ui.provider.selectOption(mockProfileId);
  await selectModelInDialog(window, mockValue, "off");
  // 审批仍使用旧 ComposerSelect；外点关闭统一 dialog 不抢走目标焦点。
  const approval = window.getByTestId("approval-mode-select");
  await approval.click();
  await ui.dialog.waitFor({ state: "hidden" });
  await assertFocus(approval, "外点关闭不抢走审批触发器焦点");
  await assertSelection(
    window,
    mockValue,
    "off",
    "外点不撤销已保存的模型与档位"
  );
  await approval.press("Escape");
  await window
    .getByTestId("approval-mode-select-listbox")
    .waitFor({ state: "hidden" });
  await ui.trigger.click();
  assert(
    (await ui.provider.inputValue()) === mockProfileId,
    "外点后重开仍定位到已保存模型的提供商"
  );
  await ui.effort("auto").click();
  await ui.dialog.waitFor({ state: "hidden" });
  await waitSelection(window, mockValue, "auto");
  await assertToolbarBounds(window);
  console.log(
    `[e2e:thinking] ${label} 提供商筛选、即时保存、键盘、固定布局与长列表滚动通过`
  );
}

async function assertThemes(window, fixture, screenshots, suffix) {
  const ui = controls(window);
  const value = modelOptionValue(fixture.longProfileId, fixture.longModelName);
  await ui.trigger.click();
  await ui.provider.selectOption(fixture.longProfileId);
  await selectModelInDialog(
    window,
    value,
    await composerOptionValue(window, "thinking-effort-select")
  );
  await ui.effort("off").click();
  await ui.dialog.waitFor({ state: "hidden" });
  for (const theme of ["light", "dark"]) {
    const current = await window.evaluate(
      () => document.documentElement.dataset.theme ?? "light"
    );
    if (current !== theme) await window.getByTestId("theme-toggle").click();
    await window.waitForFunction(
      (expected) =>
        (document.documentElement.dataset.theme ?? "light") === expected,
      theme
    );
    // 五档都在相同长模型下真实点选；既检查关闭，也检查收起后的完整档位文字。
    for (const [effort] of EFFORT_BODIES) {
      await ui.trigger.click();
      await ui.effort(effort).click();
      await ui.dialog.waitFor({ state: "hidden" });
      await waitSelection(window, value, effort);
      await window.getByTestId("composer-input").hover();
      await assertThemeColor(
        ui.trigger,
        [
          ["color", "--fg-muted"],
          ["backgroundColor", "--surface-muted"],
        ],
        `${theme} trigger 使用中性语义主题`
      );
      const label = ui.trigger.getByText(`· ${EFFORT_LABELS[effort]}`, {
        exact: true,
      });
      assert(await label.isVisible(), "长模型截断时档位文本仍显示");
      const [triggerBox, labelBox] = await Promise.all([
        ui.trigger.boundingBox(),
        label.boundingBox(),
      ]);
      assert(
        labelBox.x >= triggerBox.x &&
          labelBox.x + labelBox.width <= triggerBox.x + triggerBox.width + 1,
        "档位完整在 trigger 宽度内，不被长模型挤走"
      );
      assert(
        await ui.trigger.evaluate((element) => {
          const radius = parseFloat(getComputedStyle(element).borderRadius);
          return (
            radius > 0 && radius < element.getBoundingClientRect().height / 2
          );
        }),
        "统一 trigger 使用小圆角而非胶囊"
      );
    }
    await assertToolbarBounds(window);
    await ui.trigger.click();
    await stableLayout(window);
    await assertModelVisible(ui.model(value));
    assert(
      (await ui.model(value).getAttribute("aria-pressed")) === "true" &&
        (await ui.effort("off").getAttribute("aria-pressed")) === "true",
      "模型与档位各自保留选中态"
    );
    await assertThemeColor(
      ui.dialog,
      [
        ["backgroundColor", "--surface"],
        ["borderTopColor", "--line"],
      ],
      `${theme} dialog 表面和边框遵循主题`
    );
    await assertThemeColor(
      ui.model(value),
      [["backgroundColor", "--hover"]],
      `${theme} 模型选中态使用中性淡底色`
    );
    await assertThemeColor(
      ui.effort("off"),
      [["backgroundColor", "--hover"]],
      `${theme} 档位选中态使用中性淡底色`
    );
    await assertMenuBounds(window);
    await window.screenshot({
      path: join(screenshots, `model-thinking-${suffix}-${theme}.png`),
    });
    await window.keyboard.press("Escape");
    await ui.dialog.waitFor({ state: "hidden" });
  }
  await window.getByTestId("theme-toggle").click();
}

async function assertResizeAndScroll(app, window, fixture, screenshots) {
  const ui = controls(window);
  const originalSize = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentSize()
  );
  const originalViewport = await window.evaluate(() => [
    innerWidth,
    innerHeight,
  ]);
  await ui.trigger.click();
  await stableLayout(window);
  // 保持同一个 dialog 打开再 resize，不能只重开后碰巧位于安全范围。
  await app.evaluate(
    ({ BrowserWindow }, width) =>
      BrowserWindow.getAllWindows()[0].setContentSize(width, 640),
    NARROW_WIDTH
  );
  await window.waitForFunction(
    (width) =>
      Math.abs(innerWidth - width) <= 2 && Math.abs(innerHeight - 640) <= 2,
    NARROW_WIDTH,
    { timeout: 5000 }
  );
  await stableLayout(window);
  await assertMenuBounds(window);
  await assertModelVisible(
    ui.model(modelOptionValue(fixture.longProfileId, fixture.longModelName))
  );
  await window.keyboard.press("Escape");
  await ui.dialog.waitFor({ state: "hidden" });
  await assertThemes(window, fixture, screenshots, "narrow");
  await ui.trigger.click();
  await app.evaluate(
    ({ BrowserWindow }, size) =>
      BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]),
    originalSize
  );
  await window.waitForFunction(
    ([width, height]) =>
      Math.abs(innerWidth - width) <= 2 && Math.abs(innerHeight - height) <= 2,
    originalViewport,
    { timeout: 5000 }
  );
  await stableLayout(window);
  await assertMenuBounds(window);
  await window.keyboard.press("Escape");
  await ui.dialog.waitFor({ state: "hidden" });

  // 外层页面滚动重定位不在 E2E 里断言：主进程最小窗口高 600（display-geometry
  // MIN_WINDOW_SIZE），新建起点页内容 554 在任何合法窗口下不出滚动条；任务页
  // composer 固定于 flex 布局、不随消息流滚动——「window scroll 重定位」在当前
  // 产品布局中不可达，属防御路径，由 use-stable-popover 单测覆盖；resize/RO
  // 已在上方真实验证同一条 place 重定位逻辑。
  await window.getByTestId("settings-open").click();
  await window.getByTestId("settings-back").click();
  await assertToolbarBounds(window);
}

async function main() {
  let releaseToolRound;
  const { server, port, seenBodies } = await startMockProvider(
    (ctx, { index }) => {
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
      // 第七轮到达后明确挂住，只有真实 UI 已改模型+档位才放行 read_file，避免假测运行中。
      if (index === 7) {
        ctx.send({
          delta: { content: "等待切换下一条消息设置" },
          finish_reason: null,
        });
        releaseToolRound = () =>
          ctx.toolCallRound("call-thinking", "read_file", { path: "note.txt" });
        return;
      }
      ctx.textRound("收到");
    }
  );
  const homeDir = mkdtempSync(join(tmpdir(), "codexlike-e2e-thinking-"));
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(workspaceDir);
  writeFileSync(join(workspaceDir, "note.txt"), "思考档位 e2e 预置内容");
  let app;
  try {
    const first = await launchApp({ homeDir });
    app = first.app;
    const window = first.window;
    const ui = controls(window);
    // 冷启动无任务：审批禁用；统一模型控件禁用且可识别未配置，而不是保留隐藏旧两个控件。
    const approval = window.getByTestId("approval-mode-select");
    await approval.waitFor();
    assert(await approval.isDisabled(), "无任务时审批选择器禁用");
    assert(
      (await ui.trigger.isDisabled()) &&
        (await ui.trigger.getAttribute("aria-expanded")) === "false",
      "无任务时统一模型与思考控件禁用，不因键盘触发弹层"
    );
    assert(
      (await ui.trigger.textContent()).includes("未配置模型") &&
        (await composerOptionValue(window, "profile-select")) === "",
      "无 Profile 时保留未配置模型占位与空值"
    );
    assert(
      (await window.getByTestId("profile-select").count()) === 0 &&
        (await window.getByTestId("thinking-effort-select").count()) === 0,
      "不保留隐藏旧模型 / 思考触发器"
    );

    // 所有 Profile / 长列表均走真实设置页，不能在 evaluate 中改业务偏好。
    await window.getByTestId("settings-open").click();
    const form = window.locator("form");
    const longProfileName = `长名称模型-${"LongProfileName".repeat(12)}`;
    const longModelName = `mock-${"long-model-name-".repeat(12)}`;
    const longModels = [
      "m",
      ...Array.from(
        { length: 24 },
        (_, i) => `scroll-model-${String(i + 1).padStart(2, "0")}`
      ),
      longModelName,
    ];
    for (const [name, models] of [
      ["Mock", ["mock-model"]],
      [longProfileName, longModels],
    ]) {
      await window.getByTestId("profile-create").click();
      await form.getByLabel("名称").fill(name);
      await form.getByLabel("baseURL").fill(`http://127.0.0.1:${port}/v1`);
      await form.getByLabel("API Key").fill("sk-e2e");
      for (let i = 0; i < models.length; i++) {
        if (i > 0)
          await form
            .getByRole("button", { name: "添加模型", exact: true })
            .click();
        await form.getByLabel(`模型 ${i + 1}`, { exact: true }).fill(models[i]);
      }
      await form.getByRole("button", { name: /保存|创建/ }).click();
      await window.getByText(name, { exact: true }).waitFor();
    }
    const profiles = await window.evaluate(() =>
      window.codexlike.providerProfiles.list()
    );
    const mockProfileId = profiles.find(
      (profile) => profile.name === "Mock"
    )?.id;
    const longProfileId = profiles.find(
      (profile) => profile.name === longProfileName
    )?.id;
    assert(mockProfileId && longProfileId, "普通与长列表 Profile 均已创建");
    const fixture = {
      mockProfileId,
      longProfileId,
      longProfileName,
      longModelName,
      longModels,
    };
    const mockValue = modelOptionValue(mockProfileId, "mock-model");
    const longValue = modelOptionValue(longProfileId, longModelName);
    await window.getByTestId("settings-back").click();
    await prepareDraft(window);
    await selectComposerOption(window, "profile-select", mockValue);
    await waitSelection(window, mockValue, "auto");
    await assertDialogInteractions(window, fixture, "新建首发前");
    const screenshots = mkdtempSync(
      join(tmpdir(), "codexlike-model-thinking-screenshots-")
    );
    console.log(`[e2e:thinking] 统一选择器截图目录 ${screenshots}`);
    await assertThemes(window, fixture, screenshots, "draft");
    await assertResizeAndScroll(app, window, fixture, screenshots);
    await selectComposerOption(window, "profile-select", mockValue);
    await selectComposerOption(window, "thinking-effort-select", "auto");
    assert(
      seenBodies.length === 0,
      "新建首发前选择模型 / 档位、主题、滚动不自动发送请求"
    );
    assert(
      (await window.getByTestId("task-item").count()) === 0,
      "选择器交互不预造正式任务"
    );

    // ---- 场景 1：五档逐条发送 → 实际请求 body 符合契约 ----
    for (let i = 0; i < EFFORT_BODIES.length; i++) {
      const [effort] = EFFORT_BODIES[i];
      await selectComposerOption(window, "thinking-effort-select", effort);
      await window
        .getByTestId("composer-input")
        .fill(`第${i + 1}条：档位 ${effort}`);
      await window.getByTestId("composer-send").click();
      for (let tick = 0; tick < 100 && seenBodies.length < i + 1; tick++)
        await delay(100);
      assert(
        seenBodies.length === i + 1,
        `第${i + 1}条消息（${effort} 档）的请求未到达 mock 端`
      );
      await window.getByTestId("composer-send").waitFor();
      if (i === 0) {
        await window.getByTestId("composer-card").waitFor();
        await assertDialogInteractions(window, fixture, "已有任务");
        assert(
          seenBodies.length === 1,
          "已有任务只浏览提供商或改选择不自动发送"
        );
      }
    }
    EFFORT_BODIES.forEach(([effort, expected], i) => {
      const body = JSON.parse(seenBodies[i]);
      assert(body.model === "mock-model", `${effort} 档继续使用显式模型`);
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
    console.log("[e2e] 五档统一选择器 → 实际请求 JSON 字段全部符合契约");

    // ---- 场景 2：reasoning SSE → 折叠展示、与正文隔离、可展开 / 收起 ----
    await window.getByTestId("composer-input").fill("带思考的回答");
    await window.getByTestId("composer-send").click();
    for (let tick = 0; tick < 100 && seenBodies.length < 6; tick++)
      await delay(100);
    assert(seenBodies.length === 6, `预期 6 个请求，实际 ${seenBodies.length}`);
    const thinkingBlock = window.getByTestId("thinking-block").first();
    await thinkingBlock.waitFor({ timeout: 20_000 });
    const thinkingContent = thinkingBlock.getByTestId("thinking-content");
    assert(
      !(await thinkingContent.isVisible()),
      "思考块应默认收起（内容不可见）"
    );
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
    await thinkingBlock.getByTestId("thinking-toggle").click();
    assert(!(await thinkingContent.isVisible()), "点击收起后思考内容应不可见");
    console.log("[e2e] reasoning 流：折叠块与正文隔离，可展开 / 收起");

    // ---- 场景 3：运行中改模型和档位只影响下一条消息 ----
    await window.getByTestId("composer-send").waitFor();
    await selectComposerOption(window, "thinking-effort-select", "medium");
    await window.getByTestId("composer-input").fill("读一下 note.txt");
    await window.getByTestId("composer-send").click();
    for (let i = 0; i < 100 && !releaseToolRound; i++) await delay(100);
    assert(
      seenBodies.length === 7 && releaseToolRound,
      "第七个请求已进入工具轮闸门，回填请求尚未开始"
    );
    await window.getByTestId("composer-stop").waitFor();
    assert(
      !(await ui.trigger.isDisabled()),
      "运行中统一选择器仍可为下一条请求修改设置"
    );
    await ui.trigger.click();
    await ui.provider.selectOption(longProfileId);
    await selectModelInDialog(window, longValue, "medium");
    await ui.effort("off").click();
    await ui.dialog.waitFor({ state: "hidden" });
    await waitSelection(window, longValue, "off");
    assert(
      seenBodies.length === 7 &&
        (await window.getByTestId("composer-stop").isVisible()),
      "修改模型与档位发生在运行中，不额外发请求或中断本轮"
    );
    releaseToolRound();
    for (let i = 0; i < 100 && seenBodies.length < 8; i++) await delay(100);
    assert(seenBodies.length === 8, `预期 8 个请求，实际 ${seenBodies.length}`);
    await window
      .getByTestId("message-assistant")
      .nth(6)
      .waitFor({ timeout: 20_000 });
    await window.getByTestId("composer-send").waitFor();
    const restoredToolCard = window.getByTestId("tool-call-card").first();
    await restoredToolCard.waitFor({ timeout: 10_000 });
    assert(
      (await restoredToolCard.getAttribute("data-tool-name")) === "read_file",
      "本轮 read_file 工具卡片应存在（回看完整）"
    );
    for (const index of [6, 7]) {
      const snapshot = JSON.parse(seenBodies[index]);
      assert(
        snapshot.model === "mock-model" &&
          snapshot.thinking?.type === "enabled" &&
          snapshot.reasoning_effort === "medium",
        `运行中改值不影响本轮：请求 ${index + 1} 必须保留原模型和 medium 快照，实际 ${seenBodies[index]}`
      );
    }
    await window.getByTestId("composer-input").fill("新档位消息");
    await window.getByTestId("composer-send").click();
    for (let i = 0; i < 100 && seenBodies.length < 9; i++) await delay(100);
    assert(seenBodies.length === 9, `预期 9 个请求，实际 ${seenBodies.length}`);
    const nextMessage = JSON.parse(seenBodies[8]);
    assert(
      nextMessage.model === longModelName &&
        nextMessage.thinking?.type === "disabled",
      `下一条消息应采用新模型和 off 档：${seenBodies[8]}`
    );
    assert(
      nextMessage.reasoning_effort === undefined,
      "off 档不应附加 reasoning_effort"
    );
    console.log(
      "[e2e] 运行中改模型与档位：本轮保持原模型 medium 快照，下一条采用新模型 off"
    );

    // 删除正式任务已保存的模型，不应悄悄回退到首个可用 Profile。
    await window.getByTestId("composer-send").waitFor();
    await window.getByTestId("settings-open").click();
    const profileRow = window
      .locator("li")
      .filter({ has: window.getByText(longProfileName, { exact: true }) });
    window.once("dialog", (dialog) => dialog.accept());
    await profileRow.getByRole("button", { name: "删除", exact: true }).click();
    await profileRow.waitFor({ state: "hidden" });
    await window.getByTestId("settings-back").click();
    await ui.trigger.getByText("已保存的模型不可用", { exact: true }).waitFor();
    await assertSelection(
      window,
      longValue,
      "off",
      "失效模型保留已保存的 (Profile, 模型) 原始值与档位"
    );
    await selectComposerOption(window, "profile-select", mockValue);
    await assertSelection(
      window,
      mockValue,
      "off",
      "失效模型仍可经真实菜单显式改选可用模型，不改变档位"
    );
    assert(seenBodies.length === 9, "删除和重选模型不额外发送请求");
    await closeApp(app);
    console.log("[e2e] 模型与思考统一选择器主任务全链路通过");
  } catch (error) {
    console.error("[e2e] 模型与思考场景失败", error);
    process.exitCode = 1;
    try {
      await closeApp(app);
    } catch {
      /* 已关闭 */
    }
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
}

await main();
