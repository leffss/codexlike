// 进程内 fake MCP server（stdio）——工单 12 集成测试夹具。
// 用 node 直接运行：node fake-mcp-server.mjs [模式]
// 模式：
//   normal（默认）  注册 echo / slow_echo / crash 三个工具
//   die-immediately 启动即退出（测启动失败）
// 行为开关（环境变量）：
//   FAKE_MCP_LIST_TOOLS_DELAY_MS  延迟响应 tools/list（测连接超时的辅助）
// 由 StdioServerTransport 驱动：stdin 收 JSON-RPC、stdout 回包、stderr 日志。
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const mode = process.argv[2] ?? "normal";
// 生命周期测试只记录本次临时目录中的 PID，便于红测失败时仍精准回收。
const lifecycleDir = process.env.FAKE_MCP_LIFECYCLE_DIR;
if (lifecycleDir) {
  writeFileSync(join(lifecycleDir, `${process.pid}.started`), "started");
}
process.stdin.on("end", () => process.exit(0));

if (mode === "die-immediately") {
  process.stderr.write("fake-mcp-server: 启动即退出\n");
  process.exit(1);
}

const server = new Server(
  { name: "fake-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (lifecycleDir) {
    writeFileSync(join(lifecycleDir, `${process.pid}.listing`), "listing");
    if (existsSync(join(lifecycleDir, "hold"))) {
      while (!existsSync(join(lifecycleDir, "release"))) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
  const delay = Number(process.env.FAKE_MCP_LIST_TOOLS_DELAY_MS ?? "0");
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return {
    tools: [
      {
        name: "echo",
        description: "回显输入文本",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", description: "要回显的文本" } },
          required: ["text"],
        },
      },
      {
        name: "slow_echo",
        description: "延迟指定毫秒后回显文本（测调用超时）",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            delayMs: { type: "number", description: "延迟毫秒数" },
          },
          required: ["text"],
        },
      },
      {
        name: "crash",
        description: "调用即让 server 进程崩溃（测韧性）",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};
  if (name === "crash") {
    process.stderr.write("fake-mcp-server: 收到 crash 调用，进程退出\n");
    process.exit(1);
  }
  let delay = 0;
  if (name === "slow_echo") {
    delay = Number(args.delayMs ?? 0);
  }
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return {
    content: [
      {
        type: "text",
        text: lifecycleDir
          ? `pid: ${process.pid}`
          : `echo: ${String(args.text ?? "")}`,
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("fake-mcp-server: 已就绪\n");
