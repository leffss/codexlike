import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ProviderProfile, ProviderProfileInput } from '@codexlike/agent-core';

/**
 * Electron safeStorage 的最小接口。
 * 注入而非直接 import，使存储逻辑可脱离 Electron 单测（对应 ADR-0002 的宿主注入思想）。
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** 落盘形态：apiKey 只以加密后的 base64 出现，磁盘上无明文 */
interface StoredProfile {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  encryptedApiKey: string;
}

interface StoredFile {
  profiles: StoredProfile[];
}

export interface ProfileStore {
  /** 全部 Provider Profile（apiKey 已解密） */
  list(): ProviderProfile[];
  /** 新建并落盘；safeStorage 不可用时抛错，绝不落明文 */
  create(input: ProviderProfileInput): ProviderProfile;
  /** 更新指定 Profile；不存在时返回 undefined */
  update(id: string, input: ProviderProfileInput): ProviderProfile | undefined;
  /** 删除指定 Profile；不存在时返回 false */
  remove(id: string): boolean;
}

const FILE_NAME = 'provider-profiles.json';

/**
 * 基于 JSON 文件 + safeStorage 的 Provider Profile 存储。
 * 供 Electron 主进程装配（`~/.codexlike/` 目录 + 真实 safeStorage）。
 */
export function createProfileStore(options: {
  dir: string;
  safeStorage: SafeStorageLike;
}): ProfileStore {
  const { dir, safeStorage } = options;
  const filePath = join(dir, FILE_NAME);

  function loadFile(): StoredFile {
    try {
      const raw = readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as StoredFile;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { profiles: [] };
      }
      throw error;
    }
  }

  function saveFile(file: StoredFile): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf8');
  }

  function toStored(
    id: string,
    input: ProviderProfileInput,
  ): StoredProfile {
    const encrypted = safeStorage.encryptString(input.apiKey);
    return {
      id,
      name: input.name,
      baseURL: input.baseURL,
      model: input.model,
      encryptedApiKey: encrypted.toString('base64'),
    };
  }

  function toProfile(stored: StoredProfile): ProviderProfile {
    const encrypted = Buffer.from(stored.encryptedApiKey, 'base64');
    return {
      id: stored.id,
      name: stored.name,
      baseURL: stored.baseURL,
      apiKey: safeStorage.decryptString(encrypted),
      model: stored.model,
    };
  }

  return {
    list() {
      return loadFile().profiles.map(toProfile);
    },

    create(input) {
      requireEncryption(safeStorage);
      const file = loadFile();
      const stored = toStored(randomUUID(), input);
      saveFile({ profiles: [...file.profiles, stored] });
      return toProfile(stored);
    },

    update(id, input) {
      requireEncryption(safeStorage);
      const file = loadFile();
      const index = file.profiles.findIndex((p) => p.id === id);
      if (index === -1) {
        return undefined;
      }
      const updated = toStored(id, input);
      const profiles = [...file.profiles];
      profiles[index] = updated;
      saveFile({ profiles });
      return toProfile(updated);
    },

    remove(id) {
      const file = loadFile();
      const remaining = file.profiles.filter((p) => p.id !== id);
      if (remaining.length === file.profiles.length) {
        return false;
      }
      saveFile({ profiles: remaining });
      return true;
    },
  };
}

function requireEncryption(safeStorage: SafeStorageLike): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      '系统加密存储（safeStorage）不可用，为避免明文落盘已拒绝保存 API key',
    );
  }
}
