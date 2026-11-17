/**
 * 工具卡片参数摘要：把工具名 + 参数 JSON 压成一行人可读文本（折叠态展示）。
 * 纯函数（spec Testing Decisions：UI 纯逻辑单测）。
 */

/** 摘要长度上限（超长截断加省略号） */
const MAX_SUMMARY_LENGTH = 60;

export function summarizeToolCall(toolName: string, argsJson: string): string {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(argsJson);
    args =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    return truncate(argsJson);
  }

  const summary = summarizeByTool(toolName, args);
  return truncate(summary);
}

function summarizeByTool(
  toolName: string,
  args: Record<string, unknown>
): string {
  switch (toolName) {
    case "read_file": {
      const path = asString(args["path"]) ?? "?";
      const offset = asNumber(args["offset"]);
      const limit = asNumber(args["limit"]);
      const range =
        offset !== undefined
          ? `（第 ${offset} 行起${limit !== undefined ? `，${limit} 行` : ""}）`
          : "";
      return `${path}${range}`;
    }
    case "write_file": {
      const path = asString(args["path"]) ?? "?";
      const size = asString(args["content"])?.length ?? 0;
      return `${path}（${size} 字符）`;
    }
    case "apply_patch": {
      const patch = asString(args["patch"]) ?? "";
      const file = /Update File: (.+)|Add File: (.+)|Delete File: (.+)/.exec(
        patch
      );
      const target =
        file?.slice(1).find((group) => group !== undefined) ?? "文件";
      const changed = patch
        .split("\n")
        .filter((line) => line.startsWith("-") || line.startsWith("+")).length;
      return `${target} 的补丁（${changed} 行变更）`;
    }
    case "glob":
      return asString(args["pattern"]) ?? "?";
    case "grep": {
      const pattern = asString(args["pattern"]) ?? "?";
      const path = asString(args["path"]);
      return path !== undefined ? `${path} 中搜 ${pattern}` : pattern;
    }
    case "run_terminal_command":
      return `$ ${asString(args["command"]) ?? "?"}`;
    case "browser_navigate":
      return asString(args["url"]) ?? "?";
    case "browser_click": {
      const selector = asString(args["selector"]) ?? "?";
      return `点击 ${selector}`;
    }
    case "browser_type": {
      const selector = asString(args["selector"]) ?? "?";
      const text = asString(args["text"]) ?? "";
      return `在 ${selector} 输入 ${text}`;
    }
    case "browser_screenshot":
      return "整页截图";
    case "browser_read":
      return "提取页面正文";
    case "web_search":
      return `搜「${asString(args["query"]) ?? "?"}」`;
    case "spawn_subagent":
      // 工单 13：嵌套卡片自身展示任务全文，此处给普通工具卡片复用时的简短摘要
      return `委派：${asString(args["task"]) ?? "?"}`;
    case "update_plan": {
      // 票 03（ADR 0023）：与 agent-core 工具执行输出同口径的中文统计摘要，
      // 子代理工具清单行回看历史计划更新不读压缩 JSON；steps 非数组（历史
      // 边界）回退压缩 JSON，不输出误导统计
      const steps = args["steps"];
      if (!Array.isArray(steps)) return JSON.stringify(args);
      const count = (status: string) =>
        steps.filter(
          (step) =>
            typeof step === "object" &&
            step !== null &&
            (step as Record<string, unknown>)["status"] === status
        ).length;
      return `工作计划已更新（共 ${steps.length} 项：${count("completed")} 已完成、${count("in_progress")} 进行中、${count("pending")} 待办）`;
    }
    default: {
      // MCP 工具（mcp_<server>_<tool>，工单 12）：参数是任意 JSON Schema，
      // 有 text/query/command 类字段时优先取值，否则压缩 JSON
      if (toolName.startsWith("mcp_")) {
        const notable =
          asString(args["text"]) ??
          asString(args["query"]) ??
          asString(args["command"]) ??
          asString(args["path"]);
        return notable !== undefined
          ? `MCP ${toolName}：${notable}`
          : `MCP ${toolName} ${JSON.stringify(args)}`;
      }
      return JSON.stringify(args);
    }
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function truncate(text: string): string {
  return text.length > MAX_SUMMARY_LENGTH
    ? `${text.slice(0, MAX_SUMMARY_LENGTH)}…`
    : text;
}
