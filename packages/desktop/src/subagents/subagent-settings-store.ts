import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_SUBAGENT_MAX_CONCURRENT } from '@codexlike/agent-core/node';

/**
 * 子代理全局设置（工单 13，spec「subagents」）：设置页配置、对所有会话生效。
 * 内容为 Provider Profile 引用（模型选择）+ 并发上限，无敏感凭据，明文 JSON 落盘。
 */
export interface SubagentSettings {
  /** 子代理模型（Provider Profile 引用）；null = 同主模型（每次委派回退当前会话所选 Profile） */
  providerProfileId: string | null;
  /** 单会话子代理并发上限（1-8，默认 3）；改动对下一次委派生效 */
  maxConcurrent: number;
}

export interface SubagentSettingsStore {
  get(): Promise<SubagentSettings>;
  /** 保存设置（并发上限 1-8 校验；providerProfileId 的存在性由 IPC 边界校验） */
  set(input: SubagentSettings): Promise<SubagentSettings>;
}

const FILE_NAME = 'subagent-settings.json';
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;

function clampConcurrency(value: unknown): number {
  const num = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isInteger(num)) {
    return DEFAULT_SUBAGENT_MAX_CONCURRENT;
  }
  return Math.min(Math.max(num, MIN_CONCURRENCY), MAX_CONCURRENCY);
}

/** 子代理设置的本地存储（`~/.codexlike/subagent-settings.json`）；损坏文件按默认值处理 */
export function createSubagentSettingsStore(options: {
  dir: string;
}): SubagentSettingsStore {
  const filePath = join(options.dir, FILE_NAME);

  function loadFile(): SubagentSettings {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SubagentSettings>;
      return {
        providerProfileId:
          typeof parsed.providerProfileId === 'string' && parsed.providerProfileId !== ''
            ? parsed.providerProfileId
            : null,
        maxConcurrent: clampConcurrency(parsed.maxConcurrent),
      };
    } catch {
      // 文件不存在或损坏：默认值（同主模型 + 并发 3）
      return { providerProfileId: null, maxConcurrent: DEFAULT_SUBAGENT_MAX_CONCURRENT };
    }
  }

  return {
    async get() {
      return loadFile();
    },

    async set(input) {
      const num = input.maxConcurrent;
      if (!Number.isInteger(num) || num < MIN_CONCURRENCY || num > MAX_CONCURRENCY) {
        throw new Error(`并发上限必须是 ${MIN_CONCURRENCY}-${MAX_CONCURRENCY} 的整数`);
      }
      const next: SubagentSettings = {
        providerProfileId:
          typeof input.providerProfileId === 'string' && input.providerProfileId !== ''
            ? input.providerProfileId
            : null,
        maxConcurrent: num,
      };
      mkdirSync(options.dir, { recursive: true });
      writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
      return next;
    },
  };
}
