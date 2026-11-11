import { DiffEditor, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
// eslint 规则不适用于 vite 的 ?worker 导入（构建期替换为 Worker 构造器）。
// 注意 monaco-editor 的 exports 字段把 `./*` 映射到 `./esm/vs/*.js`，路径不带 esm/vs 前缀。
import editorWorker from 'monaco-editor/editor/editor.worker?worker';

import { useTheme } from '../lib/theme';

/**
 * Monaco DiffEditor 封装（改动面板的文件对比视图）。
 * monaco 本地打包（Electron 离线可用，不走 @monaco-editor/react 默认的 CDN loader）；
 * editor worker 必须显式提供，否则 Monaco 控制台报错且 diff/高亮失效。
 * 组件经 React.lazy 动态引入：monaco 体积大（~2MB），只在打开 diff 时加载。
 * 编辑器主题随应用外观切换（vs / vs-dark，ADR 0006）。
 */
let monacoConfigured = false;

function configureMonaco(): void {
  if (monacoConfigured) {
    return;
  }
  self.MonacoEnvironment = {
    getWorker: () => new editorWorker(),
  };
  loader.config({ monaco });
  monacoConfigured = true;
}

export default function MonacoDiff(props: {
  original: string;
  modified: string;
  language: string;
}) {
  const { theme } = useTheme();
  configureMonaco();
  return (
    <DiffEditor
      original={props.original}
      modified={props.modified}
      language={props.language}
      theme={theme === 'dark' ? 'vs-dark' : 'vs'}
      options={{
        readOnly: true,
        renderSideBySide: true,
        automaticLayout: true,
        renderOverviewRuler: false,
        minimap: { enabled: false },
        fontSize: 12,
        scrollBeyondLastLine: false,
        diffWordWrap: 'off',
      }}
    />
  );
}
