/**
 * 工具参数解析助手：把模型给出的 unknown args 校验为具体类型。
 * 校验失败抛中文错误（defineTool 统一转 isError 结果，模型可纠正参数重试）。
 */
export function parseToolArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('参数必须是一个 JSON 对象');
  }
  return args as Record<string, unknown>;
}

export function expectString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`参数 ${key} 缺失或不是非空字符串`);
  }
  return value;
}

export function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value === '') {
    throw new Error(`参数 ${key} 不是非空字符串`);
  }
  return value;
}

export function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`参数 ${key} 不是非负整数`);
  }
  return value;
}
