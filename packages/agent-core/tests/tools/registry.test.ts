import { describe, expect, it } from 'vitest';

import { createToolRegistry } from '../../src/tools/registry';
import type { ToolDefinition, ToolResult } from '../../src/tools/types';

/** 最小工具桩：只关心注册表行为，不关心执行 */
function stubTool(name: string, permission: ToolDefinition['permission'] = 'readonly'): ToolDefinition {
  return {
    name,
    description: `测试工具 ${name}`,
    parameters: { type: 'object', properties: {}, required: [] },
    permission,
    execute: async (): Promise<ToolResult> => ({ output: 'ok', isError: false }),
  };
}

describe('工具注册表', () => {
  it('注册后可按名称查找并列出全部工具', () => {
    const registry = createToolRegistry();
    registry.register(stubTool('read_file', 'readonly'));
    registry.register(stubTool('write_file', 'write'));

    expect(registry.get('read_file')?.permission).toBe('readonly');
    expect(registry.get('write_file')?.description).toBe('测试工具 write_file');
    expect(registry.list().map((tool) => tool.name)).toEqual(['read_file', 'write_file']);
  });

  it('重复注册同名工具直接抛错（注册表是稳定契约，静默覆盖会埋雷）', () => {
    const registry = createToolRegistry();
    registry.register(stubTool('read_file'));
    expect(() => registry.register(stubTool('read_file'))).toThrow('read_file');
  });

  it('未注册的名称返回 undefined', () => {
    const registry = createToolRegistry();
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });
});
