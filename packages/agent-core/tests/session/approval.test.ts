import { describe, expect, it } from 'vitest';

import {
  commandFirstWord,
  decideApproval,
} from '../../src/session/approval';

describe('commandFirstWord（审批记忆键）', () => {
  it('取命令首个空白分隔 token，大小写归一', () => {
    expect(commandFirstWord('git status')).toBe('git');
    expect(commandFirstWord('  GIT   status ')).toBe('git');
  });

  it('无命令时退化为空串（调用方决定回退键）', () => {
    expect(commandFirstWord('')).toBe('');
    expect(commandFirstWord('   ')).toBe('');
  });
});

describe('decideApproval（三档审批门，spec「审批模式」矩阵）', () => {
  const memory = new Set(['git']);

  it('readonly：只读工具放行，写入与命令一律拒绝（带可读原因）', () => {
    expect(decideApproval({ mode: 'readonly', permission: 'readonly', toolName: 'read_file', memory })).toEqual({
      kind: 'auto',
    });
    for (const permission of ['write', 'command'] as const) {
      const gate = decideApproval({ mode: 'readonly', permission, toolName: 'write_file', memory });
      expect(gate.kind).toBe('blocked');
      if (gate.kind === 'blocked') {
        expect(gate.reason).toContain('readonly');
      }
    }
  });

  it('suggest：文件编辑自动放行；命令未命中记忆则暂停等待审批', () => {
    expect(
      decideApproval({ mode: 'suggest', permission: 'readonly', toolName: 'read_file', memory }),
    ).toEqual({ kind: 'auto' });
    expect(decideApproval({ mode: 'suggest', permission: 'write', toolName: 'write_file', memory })).toEqual({
      kind: 'auto',
    });
    const gate = decideApproval({
      mode: 'suggest',
      permission: 'command',
      toolName: 'run_terminal_command',
      command: 'npm test',
      memory,
    });
    expect(gate).toEqual({ kind: 'ask', commandWord: 'npm' });
  });

  it('suggest：命令首词命中「总是允许」记忆则放行', () => {
    expect(
      decideApproval({ mode: 'suggest', permission: 'command', toolName: 'run_terminal_command', command: 'git commit -m x', memory }),
    ).toEqual({ kind: 'auto' });
  });

  it('full：一切放行', () => {
    for (const permission of ['readonly', 'write', 'command'] as const) {
      expect(decideApproval({ mode: 'full', permission, toolName: 'run_terminal_command', command: 'rm -rf /', memory })).toEqual({
        kind: 'auto',
      });
    }
  });

  it('命令类工具未提供命令参数时按工具名记忆（为 MCP 命令类工具预留）', () => {
    const gate = decideApproval({ mode: 'suggest', permission: 'command', toolName: 'mcp_deploy', memory });
    expect(gate).toEqual({ kind: 'ask', commandWord: 'mcp_deploy' });
  });
});
