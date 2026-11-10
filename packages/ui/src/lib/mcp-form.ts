import type { McpServerInput } from '@codexlike/desktop/ipc';

/** 设置页 MCP server 表单的文本态（参数/环境变量是多行文本框） */
export interface McpServerForm {
  name: string;
  command: string;
  argsText: string;
  envText: string;
}

export type McpFormParseResult =
  | ({ error: undefined } & McpServerInput)
  | { error: string };

/** 按行分割参数文本（空白行忽略、去首尾空白） */
function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** 环境变量文本（每行 KEY=VALUE）→ 对象 */
export function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of parseLines(text)) {
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key !== '') {
      env[key] = value;
    }
  }
  return env;
}

/** 环境变量对象 → 文本（与 parseEnvText 互逆，供编辑表单回显） */
export function formatEnvText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/** 表单 → MCP server 配置；非法输入返回中文 error（不抛出） */
export function parseMcpServerForm(form: McpServerForm): McpFormParseResult {
  const name = form.name.trim();
  if (name === '') {
    return { error: '请填写 server 名称' };
  }
  const command = form.command.trim();
  if (command === '') {
    return { error: '请填写启动命令' };
  }
  const env: Record<string, string> = {};
  for (const line of parseLines(form.envText)) {
    const eq = line.indexOf('=');
    if (eq <= 0) {
      return {
        error: `环境变量格式应为 KEY=VALUE（每行一个）：「${line}」不合法`,
      };
    }
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return {
    error: undefined,
    name,
    command,
    args: parseLines(form.argsText),
    env,
  };
}
