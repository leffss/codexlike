// 终端 e2e 共享小工具（09 票两个终端场景共用；与 helpers.mjs 通用骨架分开，
// 避免非终端场景关联改动）。定位器遵守 CODING_STANDARDS「E2E 定位器」：
// 交互控件走 testid，文本断言用行节点 textContent / 容器链式限定。
import { assert } from "./helpers.mjs";

/**
 * 打开检视右栏并切到「终端」tab（ADR 0033 票 04 第四 tab）：标题栏右栏
 * 开关唯一开合入口（幂等——已展开不再点），tab 切换走 rail 描边按钮。
 */
export async function openTerminalRailTab(window) {
  const toggle = window.getByTestId("resources-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await window.getByTestId("rail-tab-terminals").click();
  await window.getByTestId("terminals-panel").waitFor();
}

/**
 * xterm 文本层行断言：DOM renderer 的行节点（.xterm-rows 直接子 div）逐行
 * textContent 精确匹配。精确匹配整行即可区分「命令回显行」（含提示符与
 * 命令原文）与「真实输出行」；场景配合 $((算术)) 让输出值不出现在命令原文
 * 里，输入折行也命中不了（见 terminal-sessions.mjs 头注释）。不碰 canvas
 * 像素——xterm 6.0 默认 DOM renderer，文本在 DOM 里。
 */
export function xtermRowVisible(window, marker) {
  return window.waitForFunction(
    (expected) => {
      const rows = document.querySelectorAll(
        '[data-testid="terminal-xterm-host"] .xterm-rows > div'
      );
      return Array.from(rows).some(
        (row) => row.textContent.trim() === expected
      );
    },
    marker,
    { timeout: 20000 }
  );
}

/**
 * 聚焦终端交互区（真实输入路径前置）：点击终端区让 xterm 聚焦其隐藏输入
 * textarea；右栏重渲染可能吞掉点击焦点，未命中时直接聚焦同一输入元素兜底
 * ——键盘事件仍走 xterm onData → IPC write 全链，不绕过渲染端注入路径。
 */
export async function focusTerminal(window) {
  await window.getByTestId("terminal-xterm-host").click();
  const focused = () =>
    window.evaluate(
      () =>
        document.activeElement?.classList?.contains("xterm-helper-textarea") ===
        true
    );
  if (!(await focused())) {
    await window
      .locator(
        '[data-testid="terminal-xterm-host"] textarea.xterm-helper-textarea'
      )
      .evaluate((element) => element.focus());
  }
  assert(await focused(), "xterm 输入焦点未就绪");
}

/** 发送一条消息（回车提交，与手敲一致）。 */
export async function sendMessage(window, text) {
  const composer = window.getByTestId("composer-input");
  await composer.fill(text);
  await composer.press("Enter");
}

/**
 * 等一轮回答收尾：目标正文出现且发送按钮回到可用（任务 idle 的确定信号，
 * subagents.mjs/approvals.mjs 同款等待模式）。
 */
export async function waitForIdle(window, text) {
  await window
    .getByTestId("message-assistant")
    .filter({ hasText: text })
    .waitFor({ timeout: 20000 });
  await window.getByTestId("composer-send").waitFor();
}
