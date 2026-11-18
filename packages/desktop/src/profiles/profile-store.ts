import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  ProviderProfile,
  ProviderProfileInput,
} from "@codexlike/agent-core/node";

import { readJsonFile, writeJsonFile } from "../storage/json-file";

/**
 * Electron safeStorage 的最小接口（async 形态，Electron 45 起同步 API 已弃用）。
 * 注入而非直接 import，使存储逻辑可脱离 Electron 单测（对应 ADR-0002 的宿主注入思想）。
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): Promise<boolean>;
  encryptString(plainText: string): Promise<Buffer>;
  decryptString(encrypted: Buffer): Promise<string>;
}

/** 落盘形态：apiKey 只以加密后的 base64 出现，磁盘上无明文 */
interface StoredProfile {
  id: string;
  name: string;
  baseURL: string;
  /** 模型列表（ADR 0024 新格式） */
  models?: string[];
  /** 旧格式的单模型字段：读取时包成单元素列表，保存时不再写出 */
  model?: string;
  encryptedApiKey: string;
  /** 模型上下文窗口（tokens，可选；上下文告警阈值用），旧文件无此字段 */
  contextWindowTokens?: number;
}

interface StoredFile {
  profiles: StoredProfile[];
}

export interface ProfileStore {
  /** 全部 Provider Profile（apiKey 已解密） */
  list(): Promise<ProviderProfile[]>;
  /** 新建并落盘；safeStorage 不可用时抛错，绝不落明文 */
  create(input: ProviderProfileInput): Promise<ProviderProfile>;
  /** 更新指定 Profile；不存在时返回 null */
  update(
    id: string,
    input: ProviderProfileInput
  ): Promise<ProviderProfile | null>;
  /** 删除指定 Profile；不存在时返回 false */
  remove(id: string): Promise<boolean>;
}

const FILE_NAME = "provider-profiles.json";

/**
 * 基于 JSON 文件 + safeStorage 的 Provider Profile 存储。
 * 供 Electron 主进程装配（`~/.codexlike/` 目录 + 真实 safeStorage 的 async 适配）。
 */
export function createProfileStore(options: {
  dir: string;
  safeStorage: SafeStorageLike;
}): ProfileStore {
  const { dir, safeStorage } = options;
  const filePath = join(dir, FILE_NAME);

  function loadFile(): StoredFile {
    return readJsonFile<StoredFile>(filePath, { profiles: [] });
  }

  function saveFile(file: StoredFile): void {
    writeJsonFile(filePath, file);
  }

  async function toStored(
    id: string,
    input: ProviderProfileInput
  ): Promise<StoredProfile> {
    const encrypted = await safeStorage.encryptString(input.apiKey);
    return {
      id,
      name: input.name,
      baseURL: input.baseURL,
      models: input.models,
      encryptedApiKey: encrypted.toString("base64"),
      ...(input.contextWindowTokens !== undefined
        ? { contextWindowTokens: input.contextWindowTokens }
        : {}),
    };
  }

  async function toProfile(stored: StoredProfile): Promise<ProviderProfile> {
    const encrypted = Buffer.from(stored.encryptedApiKey, "base64");
    return {
      id: stored.id,
      name: stored.name,
      baseURL: stored.baseURL,
      apiKey: await safeStorage.decryptString(encrypted),
      // 读时升级（无版本字段，ADR 0024）：旧单 model 包成单元素列表；
      // 两个字段都缺失的坏数据宽容为空列表，与文件损坏回退同款逻辑
      models:
        stored.models ?? (stored.model !== undefined ? [stored.model] : []),
      ...(stored.contextWindowTokens !== undefined
        ? { contextWindowTokens: stored.contextWindowTokens }
        : {}),
    };
  }

  async function requireEncryption(): Promise<void> {
    if (!(await safeStorage.isEncryptionAvailable())) {
      throw new Error(
        "系统加密存储（safeStorage）不可用，为避免明文落盘已拒绝保存 API key"
      );
    }
  }

  return {
    async list() {
      const stored = loadFile().profiles;
      return Promise.all(stored.map(toProfile));
    },

    async create(input) {
      await requireEncryption();
      const stored = await toStored(randomUUID(), input);
      // 从重读到写回之间没有 await，合并加密期间已完成的新增、更新与删除。
      const file = loadFile();
      saveFile({ profiles: [...file.profiles, stored] });
      return toProfile(stored);
    },

    async update(id, input) {
      await requireEncryption();
      if (!loadFile().profiles.some((p) => p.id === id)) {
        return null;
      }
      const updated = await toStored(id, input);
      // 加密期间其它操作可以提交；同步提交段重读，不能带回旧快照或已删除项。
      const file = loadFile();
      const index = file.profiles.findIndex((p) => p.id === id);
      if (index === -1) {
        return null;
      }
      const profiles = [...file.profiles];
      profiles[index] = updated;
      saveFile({ profiles });
      return toProfile(updated);
    },

    async remove(id) {
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
