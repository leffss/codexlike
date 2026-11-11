// E2E 共享工具（code review 修复 5 抽取）：断言、应用关闭（含强杀兜底）、
// OpenAI 兼容 mock 骨架与应用启动。各 E2E 脚本只保留自己的场景逻辑
// （按请求序号/请求体特征脚本化的回复、UI 操作与断言）。
import http from "node:http";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import process from "node:process";

import { electron, launchTarget } from "./launch-target.mjs";

/** 极简断言 */
export function assert(condition, message) {
  if (!condition) {
    throw new Error(`断言失败：${message}`);
  }
}

/** 正常退出走票08确认/保存屏障；兜底只清理本次启动的进程树，不能误杀其他会话。 */
export async function closeApp(app) {
  if (!app) return;
  const child = app.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  let exited = false;
  const done = new Promise((resolve) =>
    child.once("exit", () => {
      exited = true;
      resolve();
    })
  );
  try {
    await app.evaluate(({ app }) => {
      app.quit();
    });
    const deadline = Date.now() + 10_000;
    while (!exited && Date.now() < deadline) {
      const window = app.windows()[0];
      if (window) {
        const confirm = window.getByTestId("exit-confirm");
        if (await confirm.isVisible().catch(() => false))
          await confirm.click({ timeout: 1000 }).catch(() => {});
      }
      await Promise.race([done, delay(50)]);
    }
  } finally {
    if (!exited) {
      console.warn(`[e2e] 正常退出未完成，仅清理本测试进程树 PID=${child.pid}`);
      if (process.platform === "win32") {
        await new Promise((resolve) =>
          execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], resolve)
        );
      } else child.kill("SIGKILL");
      await Promise.race([done, delay(5000)]);
      assert(exited, `测试进程 ${child.pid} 未清理，不能删除其数据目录`);
    }
  }
}

/** 仅准备新草稿；不预造空会话，也不发送额外模型请求。权限必须由场景显式选择。 */
export async function prepareDraft(
  window,
  { project = false, worktree = false, approvalMode = "ask" } = {}
) {
  // 冷启动侧栏列表尚在异步加载，使用公开宿主列表计数避免把恢复记录误判成新建。
  const before = await window.evaluate(
    async () => (await window.codexlike.sessions.list()).length
  );
  if (project) {
    if ((await window.getByTestId("project-group").count()) === 0) {
      await window.getByTestId("add-project").click();
      await window.getByTestId("project-group").waitFor();
    }
    await window.getByTestId("project-new-session").click();
  } else {
    await window.getByTestId("new-session").click();
    await window.getByTestId("draft-select-workspace").click();
  }
  if (worktree)
    await window.getByTestId("draft-workspace-mode").selectOption("worktree");
  assert(
    (await window.evaluate(
      async () => (await window.codexlike.sessions.list()).length
    )) === before,
    "首次发送前不能增加空历史"
  );
  assert(
    (await window.getByTestId("approval-mode-select").inputValue()) === "ask",
    "新会话从 ask 开始"
  );
  if (approvalMode !== "ask")
    await window.getByTestId("approval-mode-select").selectOption(approvalMode);
}

/** OpenAI 兼容 SSE 单帧（chat.completion.chunk 包装） */
function sseChunk(payload) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock-model",
    choices: [{ index: 0, ...payload }],
  })}\n\n`;
}

/**
 * /chat/completions 请求的应答工具集（骨架提供给脚本 onChat 的 ctx）：
 * - send/finishWith：SSE 帧（writeHead 惰性，脚本仍可改走 respondJson/notFound）
 * - toolCallRound/textRound：工具调用轮 / 文本轮（30ms 后收尾帧，模拟两段式流）
 * - textChunksRound：多段慢速流（客户端断开时停止）
 * - respondJson：非流式 JSON（generateText 路径，如提交消息生成）
 * - notFound：404；port：本 server 端口（构造回环 URL 用）
 */
function createChatContext(res, port) {
  const send = (payload) => {
    if (!res.headersSent) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
    }
    res.write(sseChunk(payload));
  };
  const finishWith = (reason) => {
    send({ delta: {}, finish_reason: reason });
    res.write("data: [DONE]\n\n");
    res.end();
  };
  return {
    res,
    port,
    send,
    finishWith,
    toolCallRound(callId, name, args) {
      send({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: callId,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: null,
      });
      setTimeout(() => finishWith("tool_calls"), 30);
    },
    textRound(text) {
      send({ delta: { content: text }, finish_reason: null });
      setTimeout(() => finishWith("stop"), 30);
    },
    textChunksRound(chunks, interval = 30) {
      let index = 0;
      const timer = setInterval(() => {
        try {
          if (index < chunks.length) {
            send({ delta: { content: chunks[index++] }, finish_reason: null });
            return;
          }
          clearInterval(timer);
          finishWith("stop");
        } catch {
          clearInterval(timer);
        }
      }, interval);
      // 客户端中断（abort）后停止发送
      res.on("close", () => clearInterval(timer));
    },
    respondJson(payload) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    },
    notFound() {
      if (!res.headersSent) {
        res.writeHead(404);
        res.end("not found");
      }
    },
  };
}

/**
 * 本地 OpenAI 兼容 mock 骨架：
 * - POST …/chat/completions → 收集请求体后交给 onChat(ctx)，ctx 含应答工具集与
 *   { body, index（第几个请求，从 1 起）, port }；onChat 必须自行应答（工具/文本/JSON/404）。
 * - 其余 method/path 交给 onOther(req, res)，返回 true 表示已处理，否则骨架回 404。
 * 返回 { server, port, seenBodies, requestCount() }。
 */
export function startMockProvider(onChat, onOther) {
  let requestCount = 0;
  const seenBodies = [];
  const server = http.createServer((req, res) => {
    if (
      req.method === "POST" &&
      req.url !== undefined &&
      req.url.endsWith("/chat/completions")
    ) {
      requestCount += 1;
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        seenBodies.push(body);
        onChat(createChatContext(res, server.address().port), {
          body,
          index: requestCount,
        });
      });
      return;
    }
    if (onOther === undefined || onOther(req, res) !== true) {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      resolveServer({
        server,
        port: server.address().port,
        seenBodies,
        requestCount: () => requestCount,
      });
    });
  });
}

/**
 * 启动真实 Electron 应用（生产产物）：
 * workspaceDir 缺省为 <homeDir>/workspace；extra env 合并覆盖（如 CODEXLIKE_TAVILY_URL）。
 * 主进程 stdout/stderr 与渲染进程 console.error 转打到测试日志（排障用）。
 */
export async function launchApp({ homeDir, workspaceDir, env }) {
  const fullEnv = {
    ...process.env,
    CODEXLIKE_HOME: homeDir,
    CODEXLIKE_TEST_AGENTS_HOME: join(homeDir, "compatible-agents"),
    CODEXLIKE_TEST_WORKSPACE: workspaceDir ?? join(homeDir, "workspace"),
    // 生产模式：不带 VITE_DEV_SERVER_URL，主进程以 file:// 加载 ui/dist
    VITE_DEV_SERVER_URL: "",
    ...(env ?? {}),
  };
  const app = await electron.launch(launchTarget(fullEnv));
  app
    .process()
    .stdout?.on("data", (chunk) =>
      console.log(`[main] ${String(chunk).trimEnd()}`)
    );
  app
    .process()
    .stderr?.on("data", (chunk) =>
      console.error(`[main:err] ${String(chunk).trimEnd()}`)
    );
  const window = await app.firstWindow();
  window.on("console", (message) => {
    if (message.type() === "error") {
      console.log(`[renderer console.error] ${message.text()}`);
    }
  });
  return { app, window };
}
