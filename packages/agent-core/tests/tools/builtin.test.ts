import { describe, expect, it } from 'vitest';

import { createBuiltinTools } from '../../src/tools/builtin';
import { createToolRegistry } from '../../src/tools/registry';

describe('内置工具聚合（createBuiltinTools）', () => {
  it('提供六件核心工具，名称与权限类别符合 spec', () => {
    const tools = createBuiltinTools();
    expect(tools.map((tool) => [tool.name, tool.permission])).toEqual([
      ['read_file', 'readonly'],
      ['write_file', 'write'],
      ['apply_patch', 'write'],
      ['glob', 'readonly'],
      ['grep', 'readonly'],
      ['run_terminal_command', 'command'],
    ]);
  });

  it('六件工具全部可直接注册进注册表', () => {
    const registry = createToolRegistry();
    for (const tool of createBuiltinTools()) {
      registry.register(tool);
    }
    expect(registry.list()).toHaveLength(6);
  });

  it('每件工具都有给模型的描述与 object 参数 schema', () => {
    for (const tool of createBuiltinTools()) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.parameters.type).toBe('object');
      expect(Object.keys(tool.parameters.properties ?? {}).length).toBeGreaterThan(0);
    }
  });
});
