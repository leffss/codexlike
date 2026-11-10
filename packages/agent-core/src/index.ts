// CodexLike Agent Core 公共出口。
// 本包是纯 TypeScript 的 agent 运行时，禁止 import 任何 Electron API（ADR-0002）。
//
// 出口分两层：
// - `.`（本文件）：浏览器可打包——只含类型与 provider/校验的值导出，
//   不引入任何 Node 内置模块（渲染进程的 ui 包从这里值导入）；
// - `./node`（node.ts）：Node 宿主（Electron 主进程）专用，
//   含会话对象、会话管理器与 SQLite 持久化（依赖 node:sqlite 等 Node API）。
export type {
  ProviderProfile,
  ProviderProfileErrors,
  ProviderProfileInput,
} from './provider/provider-profile';
export { validateProviderProfile } from './provider/provider-profile';

export type { CreateLanguageModelOptions } from './provider/language-model';
export { createLanguageModelFromProfile } from './provider/language-model';

// 会话域类型：type-only 再导出，浏览器侧 import type 会被完全擦除
export type {
  MessageRole,
  SessionEvent,
  SessionRecord,
  SessionStatus,
  StoredMessage,
} from './session/types';
