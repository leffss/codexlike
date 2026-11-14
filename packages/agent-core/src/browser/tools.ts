/**
 * 五件浏览器工具（spec「工具注册表与内置工具」）：browser_navigate / browser_click /
 * browser_type / browser_screenshot / browser_read。headless Chromium 由
 * BrowserTaskManager 任务级复用；权限划分——navigate/screenshot/read 是信息获取
 * （readonly），click/type 可能触发表单等交互副作用（command）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from "../tools/types";

import type { BrowserTaskManager } from "./manager";

export interface BrowserToolsOptions {
  manager: BrowserTaskManager;
  /**
   * 截图保存目录（按任务）。默认 <系统临时目录>/codexlike-screenshots/<任务id>，
   * 临时目录重启即失；需重启后找回截图的宿主（如 desktop）应注入持久目录
   */
  screenshotDirFor?: (taskId: string) => string;
}

/** browser_read 正文提取的字符上限（与终端输出同档；标记格式一致） */
export const BROWSER_READ_MAX_CHARS = 30000;

/** 页面操作默认超时（毫秒）：导航 30s、交互 10s、截图 30s */
const NAVIGATE_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;
const SCREENSHOT_TIMEOUT_MS = 30_000;

function fail(message: string): ToolResult {
  return { output: message, isError: true };
}

/** Chromium/网络错误转中文（保留原始报错关键词，模型可检索） */
function describeNavigationError(url: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "TimeoutError") {
    return `导航超时（${NAVIGATE_TIMEOUT_MS / 1000} 秒）：${url}；可稍后重试或换一个地址`;
  }
  return `导航失败：${message}（目标：${url}）；请检查网址是否可达后重试`;
}

function describeActionError(
  action: string,
  selector: string,
  error: unknown
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "TimeoutError") {
    return `browser_${action} 找不到元素：选择器 "${selector}" 在 ${
      ACTION_TIMEOUT_MS / 1000
    } 秒内未匹配到可交互元素；请先用 browser_read 查看页面结构后修正选择器`;
  }
  return `browser_${action} 失败：${message}（选择器：${selector}）`;
}

/** 截断正文并附标记（与 read_file / 终端输出的截断格式一致） */
function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n[已截断：正文共 ${text.length} 字符，已显示前 ${limit} 字符]`;
}

export function createBrowserTools(
  options: BrowserToolsOptions
): ToolDefinition[] {
  const { manager } = options;
  // 默认值落在系统临时目录：重启即失，持久化语义由注入方提供（见上方接口注释）
  const screenshotDirFor =
    options.screenshotDirFor ??
    ((taskId: string) => join(tmpdir(), "codexlike-screenshots", taskId));

  /** 未导航任务的统一引导错误 */
  async function requireOpenedPage(context: ToolExecutionContext) {
    await manager.prepare();
    const page = await manager.pageFor(context.taskId);
    if (page.url() === "about:blank") {
      throw new Error(
        "当前任务尚未打开任何页面，请先使用 browser_navigate 打开一个网址"
      );
    }
    return page;
  }

  const navigate: ToolDefinition = {
    name: "browser_navigate",
    description:
      "在任务浏览器中打开一个网页（http/https）。同一任务内共享页面与 Cookie；" +
      "返回页面标题与地址。首次使用会自动下载 Chromium（可能较慢）。",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "要打开的完整网址（http:// 或 https:// 开头）",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    permission: "readonly",
    async execute(args, context): Promise<ToolResult> {
      const url = (args as { url?: unknown }).url;
      if (typeof url !== "string" || url.trim() === "") {
        return fail("browser_navigate 需要 url 参数（完整网址）");
      }
      let parsed: URL;
      try {
        parsed = new URL(url.trim());
      } catch {
        return fail(
          `url 不是合法网址：${url}；必须是 http:// 或 https:// 开头的完整地址`
        );
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return fail(
          `仅支持 http/https 网址，收到 "${parsed.protocol}"；文件与本地协议不在浏览器工具范围内`
        );
      }
      const progressLines: string[] = [];
      try {
        await manager.prepare((line) => progressLines.push(line));
        const page = await manager.pageFor(context.taskId);
        let response: Awaited<ReturnType<typeof page.goto>> = null;
        try {
          response = await page.goto(parsed.toString(), {
            waitUntil: "domcontentloaded",
            timeout: NAVIGATE_TIMEOUT_MS,
          });
        } catch (error) {
          // 失败后页面停在 chrome-error://，后续导航会被其挂起的任务打断——
          // 整页换新（同一 context，Cookie 保留）是最可靠复位，任务保持可用
          await manager.resetPage(context.taskId).catch(() => {});
          throw error;
        }
        const title = await page.title();
        const status = response?.status();
        const statusNote =
          status !== undefined && status >= 400
            ? `（HTTP ${status}，页面可能异常）`
            : "";
        const progress =
          progressLines.length > 0 ? `${progressLines.join("\n")}\n` : "";
        return {
          output: `${progress}已打开「${title}」${parsed.toString()}${statusNote}`,
          isError: false,
        };
      } catch (error) {
        return fail(describeNavigationError(parsed.toString(), error));
      }
    },
  };

  const click: ToolDefinition = {
    name: "browser_click",
    description: "点击当前页面上匹配 CSS 选择器的元素（按钮、链接等）。",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: 'CSS 选择器（如 "#submit"、".nav a"）',
        },
      },
      required: ["selector"],
      additionalProperties: false,
    },
    permission: "command",
    async execute(args, context): Promise<ToolResult> {
      const selector = (args as { selector?: unknown }).selector;
      if (typeof selector !== "string" || selector.trim() === "") {
        return fail("browser_click 需要 selector 参数（CSS 选择器）");
      }
      try {
        const page = await requireOpenedPage(context);
        await page.click(selector, { timeout: ACTION_TIMEOUT_MS });
        const label = await page
          .locator(selector)
          .first()
          .innerText({ timeout: ACTION_TIMEOUT_MS })
          .then((text) => text.trim().replace(/\s+/g, " ").slice(0, 80))
          .catch(() => "");
        return {
          output: `已点击 ${selector}${label === "" ? "" : `（元素文本：${label}）`}`,
          isError: false,
        };
      } catch (error) {
        return fail(describeActionError("click", selector, error));
      }
    },
  };

  const type: ToolDefinition = {
    name: "browser_type",
    description:
      "在匹配 CSS 选择器的输入框中填写文本（清空原值后输入）；可选 submit 按回车提交。",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "目标输入框的 CSS 选择器" },
        text: { type: "string", description: "要输入的文本" },
        submit: {
          type: "boolean",
          description: "输入后按 Enter 提交（默认 false）",
        },
      },
      required: ["selector", "text"],
      additionalProperties: false,
    },
    permission: "command",
    async execute(args, context): Promise<ToolResult> {
      const { selector, text, submit } = args as {
        selector?: unknown;
        text?: unknown;
        submit?: unknown;
      };
      if (typeof selector !== "string" || selector.trim() === "") {
        return fail("browser_type 需要 selector 参数（CSS 选择器）");
      }
      if (typeof text !== "string") {
        return fail("browser_type 需要 text 参数（要输入的文本）");
      }
      try {
        const page = await requireOpenedPage(context);
        await page.fill(selector, text, { timeout: ACTION_TIMEOUT_MS });
        if (submit === true) {
          await page.press(selector, "Enter", { timeout: ACTION_TIMEOUT_MS });
        }
        return {
          output: `已在 ${selector} 输入 ${text.length} 字符${submit === true ? " 并按 Enter 提交" : ""}`,
          isError: false,
        };
      } catch (error) {
        return fail(describeActionError("type", selector, error));
      }
    },
  };

  const screenshot: ToolDefinition = {
    name: "browser_screenshot",
    description:
      "对当前页面整页截图（PNG）。截图保存为文件并附带在结果中：多模态模型可直接看到图片，" +
      "纯文本模型可依据结果中的文件路径查看。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    permission: "readonly",
    async execute(args, context): Promise<ToolResult> {
      void args;
      try {
        const page = await requireOpenedPage(context);
        const png = await page.screenshot({
          fullPage: true,
          timeout: SCREENSHOT_TIMEOUT_MS,
        });
        const dir = screenshotDirFor(context.taskId);
        mkdirSync(dir, { recursive: true });
        const name = `${context.toolCallId ?? Date.now()}.png`;
        const path = join(dir, name);
        writeFileSync(path, png);
        return {
          output:
            `整页截图已保存：${path}（PNG，${Math.round(png.byteLength / 1024)} KB，当前页面：${page.url()}）；` +
            "图片已附带在本条结果中",
          isError: false,
          images: [{ mediaType: "image/png", data: png.toString("base64") }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`browser_screenshot 失败：${message}`);
      }
    },
  };

  const read: ToolDefinition = {
    name: "browser_read",
    description:
      "提取当前页面的正文文本（innerTex，忽略脚本与样式标签），超长自动截断。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    permission: "readonly",
    async execute(args, context): Promise<ToolResult> {
      void args;
      try {
        const page = await requireOpenedPage(context);
        // 字符串表达式形式：不依赖 tsconfig 的 DOM lib
        const body = await page.evaluate<string>(
          'document.body ? document.body.innerText : ""'
        );
        const title = await page.title();
        const header = `标题：${title}\n地址：${page.url()}\n\n`;
        return {
          output: header + truncateText(body.trim(), BROWSER_READ_MAX_CHARS),
          isError: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`browser_read 失败：${message}`);
      }
    },
  };

  return [navigate, click, type, screenshot, read];
}
