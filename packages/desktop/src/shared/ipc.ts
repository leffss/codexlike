import type {
  ProviderProfile,
  ProviderProfileInput,
} from '@codexlike/agent-core';

/**
 * 渲染进程 ←→ 主进程 的类型化 IPC 契约。
 * preload（contextBridge）暴露 `window.codexlike`，UI 通过 `@codexlike/desktop/ipc` 引用类型。
 * 主→渲染的事件流（消息增量、工具事件等）在后续工单扩展。
 */
export const IPC = {
  providerProfiles: {
    list: 'provider-profiles:list',
    create: 'provider-profiles:create',
    update: 'provider-profiles:update',
    remove: 'provider-profiles:remove',
  },
} as const;

/** `window.codexlike` 的完整 API 形状 */
export interface CodexLikeApi {
  providerProfiles: {
    /** 全部 Provider Profile（apiKey 已解密，仅存在于渲染进程内存） */
    list(): Promise<ProviderProfile[]>;
    create(input: ProviderProfileInput): Promise<ProviderProfile>;
    /** 目标不存在时返回 null */
    update(
      id: string,
      input: ProviderProfileInput,
    ): Promise<ProviderProfile | null>;
    /** 目标不存在时返回 false */
    remove(id: string): Promise<boolean>;
  };
}
