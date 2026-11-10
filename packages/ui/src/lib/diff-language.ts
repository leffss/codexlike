/**
 * 文件路径 → Monaco language id（改动面板的 diff 高亮用）。
 * 纯函数：未命中回退 plaintext，Monaco 对未知 id 也会安全降级。
 */

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sql: 'sql',
  toml: 'ini',
  ini: 'ini',
  env: 'ini',
  txt: 'plaintext',
};

export function languageForPath(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    // 无扩展名或点开头的隐藏文件（.gitignore 等）
    return 'plaintext';
  }
  return EXTENSION_TO_LANGUAGE[name.slice(dot + 1).toLowerCase()] ?? 'plaintext';
}
