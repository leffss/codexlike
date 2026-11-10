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
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    return truncate(argsJson);
  }

  const summary = summarizeByTool(toolName, args);
  return truncate(summary);
}

function summarizeByTool(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'read_file': {
      const path = asString(args['path']) ?? '?';
      const offset = asNumber(args['offset']);
      const limit = asNumber(args['limit']);
      const range = offset !== undefined ? `（第 ${offset} 行起${limit !== undefined ? `，${limit} 行` : ''}）` : '';
      return `${path}${range}`;
    }
    case 'write_file': {
      const path = asString(args['path']) ?? '?';
      const size = asString(args['content'])?.length ?? 0;
      return `${path}（${size} 字符）`;
    }
    case 'apply_patch': {
      const patch = asString(args['patch']) ?? '';
      const file = /Update File: (.+)|Add File: (.+)|Delete File: (.+)/.exec(patch);
      const target = file?.slice(1).find((group) => group !== undefined) ?? '文件';
      const changed = patch.split('\n').filter((line) => line.startsWith('-') || line.startsWith('+')).length;
      return `${target} 的补丁（${changed} 行变更）`;
    }
    case 'glob':
      return asString(args['pattern']) ?? '?';
    case 'grep': {
      const pattern = asString(args['pattern']) ?? '?';
      const path = asString(args['path']);
      return path !== undefined ? `${path} 中搜 ${pattern}` : pattern;
    }
    case 'run_terminal_command':
      return `$ ${asString(args['command']) ?? '?'}`;
    default:
      return JSON.stringify(args);
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function truncate(text: string): string {
  return text.length > MAX_SUMMARY_LENGTH
    ? `${text.slice(0, MAX_SUMMARY_LENGTH)}…`
    : text;
}
