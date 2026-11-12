import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { CodexLikeApi } from "@codexlike/desktop/ipc";
import { WindowControls } from "../src/components/WindowControls";

function windowApi(): NonNullable<CodexLikeApi["windowControls"]> {
  return {
    getState: async () => ({ maximized: false }),
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onStateChanged: () => () => {},
  };
}

it("三个按钮分别请求最小化、切换最大化和关闭窗口", async () => {
  const api = windowApi();
  const controls = WindowControls({ api, state: { maximized: false } });
  const buttons = controls!.props.children;
  await buttons[0].props.onClick?.();
  expect(api.minimize).toHaveBeenCalledOnce();
  await buttons[1].props.onClick?.();
  expect(api.toggleMaximize).toHaveBeenCalledOnce();
  await buttons[2].props.onClick?.();
  expect(api.close).toHaveBeenCalledOnce();
});

it("窗口命令失败被处理，不向事件循环泄漏 Promise rejection", async () => {
  const fail = async () => {
    throw new Error("窗口已销毁");
  };
  const controls = WindowControls({
    api: { ...windowApi(), minimize: fail, toggleMaximize: fail, close: fail },
    state: { maximized: false },
  });
  for (const button of controls!.props.children) {
    await expect(button.props.onClick()).resolves.toBeUndefined();
  }
});

it("没有窗口控制能力时不渲染窗口按钮", () => {
  expect(
    renderToStaticMarkup(
      createElement(WindowControls, {
        api: undefined,
        state: { maximized: false },
      })
    )
  ).toBe("");
});

it("最大化窗口显示还原动作且保留同一定位器", () => {
  const html = renderToStaticMarkup(
    createElement(WindowControls, {
      api: windowApi(),
      state: { maximized: true },
    })
  );
  expect(html).toMatch(
    /<button[^>]*data-testid="window-maximize"[^>]*aria-label="还原"[^>]*title="还原"/
  );
  expect(html).not.toContain('aria-label="最大化"');
});

it("窗口按钮提供中文名称、提示和稳定定位器", () => {
  const html = renderToStaticMarkup(
    createElement(WindowControls, {
      api: windowApi(),
      state: { maximized: false },
    })
  );
  for (const [id, label] of [
    ["window-minimize", "最小化"],
    ["window-maximize", "最大化"],
    ["window-close", "关闭"],
  ]) {
    expect(html).toMatch(
      new RegExp(
        `<button[^>]*data-testid="${id}"[^>]*aria-label="${label}"[^>]*title="${label}"`
      )
    );
  }
  expect(html.match(/type="button"/g)).toHaveLength(3);
  expect(html.match(/aria-hidden="true"/g)).toHaveLength(3);
});
