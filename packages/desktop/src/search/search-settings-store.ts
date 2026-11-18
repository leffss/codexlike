import { rmSync } from "node:fs";
import { join } from "node:path";

import type { SafeStorageLike } from "../profiles/profile-store";
import { readJsonFile, writeJsonFile } from "../storage/json-file";

/** 搜索源设置（工单 10）：当前默认且仅有 Tavily，provider 字段留扩展口 */
export interface SearchSettings {
  /** 搜索源类型（spec「web_search 与浏览器」：搜索源抽象为接口可替换） */
  provider: "tavily";
  /** API key；'' 表示未配置（web_search 返回中文指引） */
  apiKey: string;
}

export interface SearchSettingsStore {
  get(): Promise<SearchSettings>;
  /** 保存 key（空字符串清除配置）；safeStorage 不可用时拒绝保存、绝不落明文 */
  set(input: { apiKey: string }): Promise<SearchSettings>;
}

/** 落盘形态：只存加密后的 base64，磁盘上无明文（沿用 01 的 safeStorage 模式） */
interface StoredFile {
  provider: "tavily";
  encryptedApiKey: string;
}

const FILE_NAME = "search-settings.json";

/**
 * 搜索源设置的本地存储（`~/.codexlike/search-settings.json`）。
 * 与 Provider Profile 同款注入式 safeStorage（ADR-0002 宿主注入思想），可脱离 Electron 单测。
 */
export function createSearchSettingsStore(options: {
  dir: string;
  safeStorage: SafeStorageLike;
}): SearchSettingsStore {
  const { dir, safeStorage } = options;
  const filePath = join(dir, FILE_NAME);

  function loadFile(): StoredFile | null {
    const parsed = readJsonFile<StoredFile | null>(filePath, null);
    if (
      parsed === null ||
      parsed.provider !== "tavily" ||
      typeof parsed.encryptedApiKey !== "string"
    ) {
      return null;
    }
    return parsed;
  }

  function saveFile(file: StoredFile): void {
    writeJsonFile(filePath, file);
  }

  async function toSettings(
    stored: StoredFile | null
  ): Promise<SearchSettings> {
    if (stored === null) {
      return { provider: "tavily", apiKey: "" };
    }
    const decrypted = await safeStorage.decryptString(
      Buffer.from(stored.encryptedApiKey, "base64")
    );
    return { provider: "tavily", apiKey: decrypted };
  }

  return {
    async get() {
      return toSettings(loadFile());
    },

    async set(input) {
      if (input.apiKey === "") {
        // 清除配置：删文件回到未配置态
        rmSync(filePath, { force: true });
        return { provider: "tavily", apiKey: "" };
      }
      if (!(await safeStorage.isEncryptionAvailable())) {
        throw new Error(
          "系统加密存储（safeStorage）不可用，为避免明文落盘已拒绝保存搜索 API key"
        );
      }
      const encrypted = await safeStorage.encryptString(input.apiKey);
      const stored: StoredFile = {
        provider: "tavily",
        encryptedApiKey: encrypted.toString("base64"),
      };
      // 解密失败也属于保存失败：返回值就绪后才替换原配置。
      const settings = await toSettings(stored);
      saveFile(stored);
      return settings;
    },
  };
}
