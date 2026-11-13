import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { beforeEach, expect, it, vi } from "vitest";
import { registerNavigationPolicy } from "../src/window/navigation-policy";

const native = vi.hoisted(() => ({
  openExternal: vi.fn().mockResolvedValue(undefined),
  showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
}));
vi.mock("electron", () => ({ shell: native, dialog: native }));

class Contents extends EventEmitter {
  openWindow!: Parameters<WebContents["setWindowOpenHandler"]>[0];
  setWindowOpenHandler(handler: typeof this.openWindow) {
    this.openWindow = handler;
  }
}

const fileEntry = "file:///C:/CodexLike/ui-dist/index.html";
const devEntry = "http://localhost:5173/app/?mode=desktop";

function setup(entry = fileEntry) {
  const contents = new Contents();
  registerNavigationPolicy(contents, entry);
  return contents;
}

// Electron 45 在 details 上提供 URL/frame；旧位置参数仍存在。
function navigation(
  contents: Contents,
  name: string,
  url: string,
  isMainFrame = true
) {
  const details = {
    url,
    isMainFrame,
    isSameDocument: false,
    frame: null,
    initiator: null,
    preventDefault: vi.fn(),
  };
  if (name === "will-frame-navigate") contents.emit(name, details);
  else contents.emit(name, details, url, false, isMainFrame, 1, 2);
  return details;
}

it.each([fileEntry, devEntry])("精确入口 %s 的刷新和锚点可用", (entry) => {
  const contents = setup(entry);
  for (const url of [entry, `${entry}#section`]) {
    const event = navigation(contents, "will-navigate", url);
    expect(event.preventDefault).not.toHaveBeenCalled();
  }
  expect(native.openExternal).not.toHaveBeenCalled();
});

it.each([
  "javascript:alert(1)",
  "data:text/html,hello",
  "mailto:hello@example.com",
  "custom://launch",
  "about:blank",
  "file:///C:/secret.html",
  `${fileEntry}?other=1`,
  `${fileEntry}/other`,
  "../other.html",
  "/other",
  "//example.com/page",
  "not a URL",
  "",
  "https://user:password@example.com/",
  "https://",
  "https:example.com",
])("不可信导航 %s 被阻止且不交给操作系统", (url) => {
  const contents = setup();
  expect(
    navigation(contents, "will-navigate", url).preventDefault
  ).toHaveBeenCalledOnce();
  expect(native.openExternal).not.toHaveBeenCalled();
});

it.each([
  "http://localhost:5173/other",
  "http://localhost:5173/app/child",
  "http://localhost:5173/app/?mode=other",
  "http://localhost:5173/app/",
])("开发服务器解析后的相对路径 %s 不打开浏览器也不替换工作台", (url) => {
  const contents = setup(devEntry);
  expect(
    navigation(contents, "will-navigate", url).preventDefault
  ).toHaveBeenCalledOnce();
  expect(native.openExternal).not.toHaveBeenCalled();
});

it("子 frame 和自动重定向均不得加载外文档或启动浏览器", () => {
  const contents = setup(devEntry);
  for (const name of ["will-frame-navigate", "will-redirect"]) {
    for (const url of [
      "https://example.com/redirect",
      "http://localhost:5173/other",
      "data:text/html,hi",
      devEntry,
    ]) {
      expect(
        navigation(contents, name, url, false).preventDefault
      ).toHaveBeenCalledOnce();
    }
  }
  expect(
    navigation(contents, "will-redirect", "https://example.com/redirect")
      .preventDefault
  ).toHaveBeenCalledOnce();
  expect(
    navigation(contents, "will-redirect", `${devEntry}#section`).preventDefault
  ).not.toHaveBeenCalled();
  expect(native.openExternal).not.toHaveBeenCalled();
});

function popup(contents: Contents, url: string) {
  return contents.openWindow({
    url,
    frameName: "_blank",
    features: "",
    disposition: "new-window",
    referrer: { url: fileEntry, policy: "default" },
  });
}

it("所有新窗口一律 deny，仅合法外链交给浏览器", () => {
  const contents = setup(devEntry);
  for (const url of [
    "https://example.com/docs",
    devEntry,
    `${devEntry}#anchor`,
    "http://localhost:5173/other",
    "file:///C:/secret.html",
    "javascript:alert(1)",
    "../other",
  ]) {
    expect(popup(contents, url)).toEqual({ action: "deny" });
  }
  expect(native.openExternal.mock.calls).toEqual([
    ["https://example.com/docs"],
  ]);
});

it.each(["navigation", "popup"])(
  "%s 外部打开失败仍取消导航，并显示简短原生提示",
  async (source) => {
    native.openExternal.mockRejectedValueOnce(new Error("OS refused"));
    const contents = setup();
    if (source === "popup") {
      expect(popup(contents, "https://example.com/fail")).toEqual({
        action: "deny",
      });
    } else {
      expect(
        navigation(contents, "will-navigate", "https://example.com/fail")
          .preventDefault
      ).toHaveBeenCalledOnce();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(native.showMessageBox).toHaveBeenCalledExactlyOnceWith({
      type: "warning",
      title: "无法打开链接",
      message: "无法在默认浏览器中打开链接，请稍后重试。",
      buttons: ["确定"],
    });
    // 失败不回退加载页面，下一次点击仍然可以正常打开。
    navigation(contents, "will-navigate", "https://example.com/retry");
    expect(native.openExternal).toHaveBeenLastCalledWith(
      "https://example.com/retry"
    );
  }
);

it("独立的重复点击不被去重，随后重定向不会额外打开浏览器", () => {
  const contents = setup();
  for (let attempt = 0; attempt < 2; attempt++) {
    navigation(contents, "will-frame-navigate", "https://example.com/docs");
    expect(
      navigation(contents, "will-navigate", "https://example.com/docs")
        .preventDefault
    ).toHaveBeenCalledOnce();
    expect(
      navigation(contents, "will-redirect", "https://example.com/next")
        .preventDefault
    ).toHaveBeenCalledOnce();
  }
  expect(native.openExternal.mock.calls).toEqual([
    ["https://example.com/docs"],
    ["https://example.com/docs"],
  ]);
});

it("同步系统异常和原生提示失败不逃逸到窗口处理器或遗留 rejection", async () => {
  native.openExternal.mockImplementationOnce(() => {
    throw new Error("OS unavailable");
  });
  native.showMessageBox.mockRejectedValueOnce(new Error("dialog unavailable"));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(popup(setup(), "https://example.com/fail")).toEqual({
      action: "deny",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(native.showMessageBox).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
  } finally {
    warning.mockRestore();
  }
});

it("入口 URL 配置无效时拒绝注册，不退化为任意页面白名单", () => {
  for (const entry of [
    "/index.html",
    "javascript:alert(1)",
    "https://user:password@localhost/",
  ]) {
    expect(() => setup(entry)).toThrow("应用入口 URL 无效");
  }
});

it("Electron 45 details 独立提供导航参数，不依赖废弃的位置参数", () => {
  const contents = setup();
  const details = {
    url: "https://example.com/docs",
    isMainFrame: true,
    isSameDocument: false,
    frame: null,
    initiator: null,
    preventDefault: vi.fn(),
  };
  contents.emit("will-navigate", details);
  expect(details.preventDefault).toHaveBeenCalledOnce();
  expect(native.openExternal).toHaveBeenCalledExactlyOnceWith(
    "https://example.com/docs"
  );
});

it("子 frame 发起的顶层导航被阻止，不借主 frame 打开系统浏览器", () => {
  const contents = setup();
  const event = {
    url: "https://example.com/from-iframe",
    isMainFrame: true,
    initiator: { parent: {} },
    preventDefault: vi.fn(),
  };
  contents.emit("will-frame-navigate", event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  contents.emit("will-navigate", event);
  expect(native.openExternal).not.toHaveBeenCalled();
});

beforeEach(() => {
  native.openExternal.mockReset().mockResolvedValue(undefined);
  native.showMessageBox.mockReset().mockResolvedValue({ response: 0 });
});

it.each(["http://example.com/docs", "https://example.com/docs#usage"])(
  "主 frame 点击 %s 保留原文档，两个导航事件只打开一次浏览器",
  (url) => {
    const contents = setup();
    const frame = navigation(contents, "will-frame-navigate", url);
    // Chromium 仅在前一个事件未取消时继续发出 will-navigate。
    if (!frame.preventDefault.mock.calls.length) {
      const main = navigation(contents, "will-navigate", url);
      expect(main.preventDefault).toHaveBeenCalledOnce();
    }
    expect(native.openExternal.mock.calls).toEqual([[url]]);
    expect(native.showMessageBox).not.toHaveBeenCalled();
  }
);
