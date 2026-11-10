import { describe, expect, it } from 'vitest';

import {
  validateProviderProfile,
  type ProviderProfileInput,
} from '../../src/index';

describe('validateProviderProfile（Provider Profile 表单校验）', () => {
  const validInput: ProviderProfileInput = {
    name: 'GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: 'sk-test',
    model: 'glm-4.7',
  };

  it('合法输入返回空错误对象（校验通过）', () => {
    expect(validateProviderProfile(validInput)).toEqual({});
  });

  it('name 为空时给出 name 错误', () => {
    const errors = validateProviderProfile({
      ...validInput,
      name: ' ',
    });

    expect(errors.name).toBe('请填写名称');
  });

  it('baseURL 不是合法 URL 时给出 baseURL 错误', () => {
    const errors = validateProviderProfile({
      ...validInput,
      baseURL: 'not-a-url',
    });

    expect(errors.baseURL).toBe('baseURL 不是合法的 URL');
  });

  it('model 为空时给出 model 错误', () => {
    const errors = validateProviderProfile({
      ...validInput,
      model: '',
    });

    expect(errors.model).toBe('请填写模型名称');
  });
});
