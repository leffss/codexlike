import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBrowserSessionManager } from "../../src/browser/manager";
import { createBrowserTools } from "../../src/browser/tools";
import type { BrowserSessionManager } from "../../src/browser/manager";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../src/tools/types";
import { startFixtureServer, type FixtureServer } from "./fixture-server";

/**
 * 五件浏览器工具在本地 fixture 上的行为测试（真实 Chromium；spec：
 * navigate→type→click→read→screenshot 全链 + 失败路径）。
 */
describe("浏览器工具组（真实 Chromium + 本地 fixture）", () => {
  let fixture: FixtureServer;
  let manager: BrowserSessionManager;
  let screenshotDir: string;
  let tools: ToolDefinition[];
  const byName = () => new Map(tools.map((tool) => [tool.name, tool]));

  function context(toolCallId = "call-1"): ToolExecutionContext {
    return {
      workspacePath: tmpdir(),
      sessionId: "browser-tools-test",
      approvalMode: "assist",
      toolCallId,
    };
  }

  beforeAll(async () => {
    fixture = await startFixtureServer();
    screenshotDir = mkdtempSync(join(tmpdir(), "codexlike-shots-"));
    manager = createBrowserSessionManager();
    tools = createBrowserTools({
      manager,
      screenshotDirFor: () => screenshotDir,
    });
  }, 120_000);

  afterAll(async () => {
    await manager.close();
    await fixture.close();
  });

  it("五件工具齐全，权限类别按信息获取/交互副作用划分", () => {
    expect(tools.map((tool) => [tool.name, tool.permission])).toEqual([
      ["browser_navigate", "readonly"],
      ["browser_click", "command"],
      ["browser_type", "command"],
      ["browser_screenshot", "readonly"],
      ["browser_read", "readonly"],
    ]);
  });

  it("navigate→type→click→read→screenshot 全链（同一会话共享页面状态）", async () => {
    const navigate = byName().get("browser_navigate")!;
    const type = byName().get("browser_type")!;
    const click = byName().get("browser_click")!;
    const read = byName().get("browser_read")!;
    const screenshot = byName().get("browser_screenshot")!;

    // 导航：标题与 URL 回报
    const nav = await navigate.execute(
      { url: `${fixture.origin}/form` },
      context()
    );
    expect(nav.isError).toBe(false);
    expect(nav.output).toContain("测试表单页");
    expect(nav.output).toContain("/form");

    // 输入框填写
    const typed = await type.execute(
      { selector: "#query", text: "playwright 自动化" },
      context("call-2")
    );
    expect(typed.isError).toBe(false);

    // 点击提交按钮（页面 JS 把输入值渲染进结果区）
    const clicked = await click.execute(
      { selector: "#submit" },
      context("call-3")
    );
    expect(clicked.isError).toBe(false);

    // 读取正文：看到点击后的交互结果
    const content = await read.execute({}, context("call-4"));
    expect(content.isError).toBe(false);
    expect(content.output).toContain("已提交：playwright 自动化");

    // 整页截图：文件真实存在且是 PNG
    const shot = await screenshot.execute({}, context("call-shot-1"));
    expect(shot.isError).toBe(false);
    expect(shot.output).toContain(join(screenshotDir, "call-shot-1.png"));
    const file = join(screenshotDir, "call-shot-1.png");
    expect(existsSync(file)).toBe(true);
    const head = readFileSync(file).subarray(0, 8);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(statSync(file).size).toBeGreaterThan(1000);
    // 截图附带图片附件（多模态端点附给模型；降级端点读 output 内路径）
    expect(shot.images?.[0]?.mediaType).toBe("image/png");
    expect(shot.images?.[0]?.data.length ?? 0).toBeGreaterThan(100);
  }, 120_000);

  it("browser_read 截断超长正文并带标记", async () => {
    const navigate = byName().get("browser_navigate")!;
    const read = byName().get("browser_read")!;
    await navigate.execute(
      { url: `${fixture.origin}/article` },
      context("call-5")
    );
    const content = await read.execute({}, context("call-6"));
    expect(content.isError).toBe(false);
    expect(content.output).toContain("长文测试页标题");
    expect(content.output).toContain("[已截断：");
    expect(content.output.length).toBeLessThan(40000);
  }, 60_000);

  it("navigate 到无法连接的地址返回明确错误，会话不崩（后续调用正常）", async () => {
    const navigate = byName().get("browser_navigate")!;
    // 探测一个确定未监听的端口（连接拒绝而非被 Chromium 屏蔽的端口）
    const probe = createServer();
    await new Promise<void>((resolve) =>
      probe.listen(0, "127.0.0.1", () => resolve())
    );
    const deadPort = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const result = await navigate.execute(
      { url: `http://127.0.0.1:${deadPort}/not-reachable` },
      context("call-7")
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("导航失败");
    expect(result.output).toContain("ERR_CONNECTION_REFUSED");
    // 会话仍可用
    const ok = await navigate.execute(
      { url: `${fixture.origin}/form` },
      context("call-8")
    );
    expect(ok.isError).toBe(false);
  }, 60_000);

  it("navigate 拒绝非 http(s) 协议", async () => {
    const navigate = byName().get("browser_navigate")!;
    for (const url of [
      "file:///C:/Windows/win.ini",
      "javascript:alert(1)",
      "不是网址",
    ]) {
      const result = await navigate.execute({ url }, context());
      expect(result.isError, url).toBe(true);
      expect(result.output, url).toContain("http");
    }
  });

  it("click/type 选择器找不到元素返回中文错误", async () => {
    const click = byName().get("browser_click")!;
    const type = byName().get("browser_type")!;
    const clicked = await click.execute(
      { selector: "#does-not-exist" },
      context()
    );
    expect(clicked.isError).toBe(true);
    expect(clicked.output).toContain("找不到");
    const typed = await type.execute(
      { selector: "#also-missing", text: "x" },
      context()
    );
    expect(typed.isError).toBe(true);
    expect(typed.output).toContain("找不到");
  }, 60_000);

  it("read/screenshot 在未导航的会话上返回引导性错误", async () => {
    const fresh = createBrowserTools({
      manager,
      screenshotDirFor: () => screenshotDir,
    });
    const read = fresh.find((tool) => tool.name === "browser_read")!;
    const shot = fresh.find((tool) => tool.name === "browser_screenshot")!;
    // 另一个 sessionId：全新 context，从未导航
    const virginContext: ToolExecutionContext = {
      workspacePath: tmpdir(),
      approvalMode: "assist",
      sessionId: "never-navigated",
      toolCallId: "call-9",
    };
    const readResult = await read.execute({}, virginContext);
    expect(readResult.isError).toBe(true);
    expect(readResult.output).toContain("browser_navigate");
    const shotResult = await shot.execute({}, virginContext);
    expect(shotResult.isError).toBe(true);
    expect(shotResult.output).toContain("browser_navigate");
    await manager.closeSession("never-navigated");
  }, 60_000);

  it("不同会话的当前页互不干扰", async () => {
    const navigate = byName().get("browser_navigate")!;
    const read = byName().get("browser_read")!;
    await navigate.execute(
      { url: `${fixture.origin}/article` },
      {
        workspacePath: tmpdir(),
        sessionId: "isolated-a",
        approvalMode: "assist",
        toolCallId: "ia",
      }
    );
    await navigate.execute(
      { url: `${fixture.origin}/form` },
      {
        workspacePath: tmpdir(),
        sessionId: "isolated-b",
        approvalMode: "assist",
        toolCallId: "ib",
      }
    );
    const readA = await read.execute(
      {},
      {
        workspacePath: tmpdir(),
        sessionId: "isolated-a",
        approvalMode: "assist",
        toolCallId: "ia2",
      }
    );
    expect(readA.output).toContain("长文测试页标题");
    await manager.closeSession("isolated-a");
    await manager.closeSession("isolated-b");
  }, 60_000);
});
