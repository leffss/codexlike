import type { CodexLikeApi } from '@codexlike/desktop/ipc';

/**
 * preload 经 contextBridge 暴露的 API（见 desktop/src/preload.ts）。
 * 类型契约唯一来源是 `@codexlike/desktop/ipc`。
 */
declare global {
  interface Window {
    codexlike: CodexLikeApi;
  }
}

export {};
