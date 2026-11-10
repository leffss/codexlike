import { describe, expect, it } from 'vitest';

import { languageForPath } from '../src/lib/diff-language';

describe('languageForPath（文件路径 → Monaco language id）', () => {
  it('常见扩展名映射到 Monaco language id', () => {
    expect(languageForPath('src/app.ts')).toBe('typescript');
    expect(languageForPath('src/app.tsx')).toBe('typescript');
    expect(languageForPath('build.js')).toBe('javascript');
    expect(languageForPath('package.json')).toBe('json');
    expect(languageForPath('styles/app.css')).toBe('css');
    expect(languageForPath('index.html')).toBe('html');
    expect(languageForPath('README.md')).toBe('markdown');
    expect(languageForPath('run.sh')).toBe('shell');
    expect(languageForPath('main.py')).toBe('python');
    expect(languageForPath('Cargo.toml')).toBe('ini');
  });

  it('未知扩展名与无扩展名回退 plaintext', () => {
    expect(languageForPath('data.unknownext')).toBe('plaintext');
    expect(languageForPath('LICENSE')).toBe('plaintext');
    expect(languageForPath('')).toBe('plaintext');
  });

  it('大小写不敏感（.TS 与 .ts 等价）', () => {
    expect(languageForPath('src/app.TS')).toBe('typescript');
  });
});
