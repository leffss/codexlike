import { dialog, shell, type WebContents } from "electron";

type NavigationEvent = {
  url: string;
  isMainFrame: boolean;
  initiator?: { parent: unknown } | null;
  preventDefault(): void;
};

type NavigationContents = {
  on(
    event: "will-navigate" | "will-frame-navigate" | "will-redirect",
    listener: (event: NavigationEvent) => void
  ): unknown;
  setWindowOpenHandler: WebContents["setWindowOpenHandler"];
};

function parseUrl(value: string): URL | null {
  // 不补全相对路径，也不接受 URL 解析器会容错的控制字符、反斜杠或省略 //。
  if (
    !/^(https?|file):\/\//i.test(value) ||
    // eslint-disable-next-line no-control-regex -- 控制字符类正是拒绝目标：匹配到即判不可信 URL，非误用
    /[\u0000-\u0020\u007f\\]/.test(value)
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url;
  } catch {
    return null;
  }
}

function documentUrl(url: URL): string {
  const document = new URL(url.href);
  document.hash = "";
  return document.href;
}

export function registerNavigationPolicy(
  contents: NavigationContents,
  entryUrl: string
): void {
  const entry = parseUrl(entryUrl);
  if (!entry) throw new Error("应用入口 URL 无效");
  const entryDocument = documentUrl(entry);
  const devOrigin = entry.protocol === "file:" ? null : entry.origin;
  const isEntry = (url: URL | null) =>
    url !== null && documentUrl(url) === entryDocument;
  function openExternal(url: URL | null): void {
    if (!url || !["http:", "https:"].includes(url.protocol) || isEntry(url))
      return;
    // Electron 已把相对链接解析成绝对 URL，无法再区分同源绝对/相对写法。
    // 保守拒绝开发服务器的所有非入口页面；不把本地应用路由交给浏览器。
    if (url.origin === devOrigin) return;
    void (async () => {
      try {
        await shell.openExternal(url.href);
      } catch {
        try {
          await dialog.showMessageBox({
            type: "warning",
            title: "无法打开链接",
            message: "无法在默认浏览器中打开链接，请稍后重试。",
            buttons: ["确定"],
          });
        } catch {
          // 退出期间原生提示也可能不可用；不遗留未处理 rejection，也不回退导航。
          console.warn("[navigation] 无法显示外部链接打开失败提示");
        }
      }
    })();
  }
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(parseUrl(url));
    return { action: "deny" };
  });
  contents.on("will-frame-navigate", (event) => {
    // 主 frame 随后的 will-navigate 统一取消/外部打开，避免一次导航打开两次。
    // 子 frame 一律取消，不让嵌入内容自动启动系统浏览器。
    if (!event.isMainFrame || event.initiator?.parent) event.preventDefault();
  });
  contents.on("will-redirect", (event) => {
    // 自动重定向没有点击意图，只取消，绝不外部打开。
    if (!event.isMainFrame || !isEntry(parseUrl(event.url)))
      event.preventDefault();
  });
  contents.on("will-navigate", (event) => {
    const url = parseUrl(event.url);
    const mainNavigation = event.isMainFrame && !event.initiator?.parent;
    if (mainNavigation && isEntry(url)) return;
    event.preventDefault();
    if (mainNavigation) openExternal(url);
  });
}
