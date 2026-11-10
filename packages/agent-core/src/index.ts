// CodexLike Agent Core 公共出口。
// 本包是纯 TypeScript 的 agent 运行时，禁止 import 任何 Electron API（ADR-0002）。
// 后续工单（对话循环、工具注册表、审批状态机等）都在此出口下扩展。
export type {
  ProviderProfile,
  ProviderProfileErrors,
  ProviderProfileInput,
} from './provider/provider-profile';
export { validateProviderProfile } from './provider/provider-profile';
