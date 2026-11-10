import { describe, expect, it } from 'vitest';

import {
  formatEnvText,
  parseEnvText,
  parseMcpServerForm,
} from '../src/lib/mcp-form';

describe('parseMcpServerForm（设置页 MCP 表单 → 配置）', () => {
  it('正常解析：名称/命令必填，参数按行分割、环境变量按 KEY=VALUE 行解析', () => {
    const parsed = parseMcpServerForm({
      name: 'fake',
      command: 'node',
      argsText: 'server.js\n--stdio',
      envText: 'TOKEN=abc123\nDEBUG=1',
    });
    expect(parsed).toEqual({
      name: 'fake',
      command: 'node',
      args: ['server.js', '--stdio'],
      env: { TOKEN: 'abc123', DEBUG: '1' },
    });
  });

  it('空白行被忽略；参数与环境变量留空得到空数组/空对象', () => {
    const parsed = parseMcpServerForm({
      name: 'x',
      command: 'cmd',
      argsText: '\n  \n',
      envText: '',
    });
    expect(parsed).toEqual({ name: 'x', command: 'cmd', args: [], env: {} });
  });

  it('名称或命令为空：返回中文错误', () => {
    expect(
      parseMcpServerForm({ name: '', command: 'node', argsText: '', envText: '' })
        .error,
    ).toBe('请填写 server 名称');
    expect(
      parseMcpServerForm({ name: 'x', command: '  ', argsText: '', envText: '' })
        .error,
    ).toBe('请填写启动命令');
  });

  it('环境变量行缺 = 号：返回中文错误并指明行内容', () => {
    const parsed = parseMcpServerForm({
      name: 'x',
      command: 'node',
      argsText: '',
      envText: 'GOOD=1\nBADLINE',
    });
    expect(parsed.error).toContain('BADLINE');
    expect(parsed.error).toContain('KEY=VALUE');
  });

  it('环境变量值可以包含 = 号（首个等号分隔）', () => {
    const parsed = parseMcpServerForm({
      name: 'x',
      command: 'node',
      argsText: '',
      envText: 'CONN=a=b&c=d',
    });
    expect(parsed).toEqual({
      name: 'x',
      command: 'node',
      args: [],
      env: { CONN: 'a=b&c=d' },
      error: undefined,
    });
  });
});

describe('环境变量文本 <-> 对象 的往返', () => {
  it('parseEnvText 与 formatEnvText 互逆', () => {
    const text = 'A=1\nB=two words';
    expect(formatEnvText(parseEnvText(text))).toBe(text);
  });

  it('空对象格式化为空字符串', () => {
    expect(formatEnvText({})).toBe('');
  });
});
