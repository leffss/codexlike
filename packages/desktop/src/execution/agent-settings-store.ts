import { join } from "node:path";

import {
  DEFAULT_MAX_TOOL_ROUNDS,
  TOOL_ROUNDS_MAX,
  TOOL_ROUNDS_MIN,
} from "@codexlike/agent-core/node";

import { readJsonFile, writeJsonFile } from "../storage/json-file";

/**
 * 执行设置存储（ADR 0017，GLOSSARY「执行设置」）：agent 执行参数的用户设置，
 * 独立文件 `~/.codexlike/agent-settings.json` 持久化（与现有各设置文件同形态）。
 * 首个参数：主任务工具轮次上限——经内存缓存以 resolver 注入 agent-core
 * （回合开始快照消费），设置页保存后对下一个回合生效。
 */
export interface AgentSettings {
  /** 主任务工具轮次上限（10–1000，默认 200）；改动对下一个回合生效 */
  maxToolRounds: number;
}

export interface AgentSettingsStore {
  get(): Promise<AgentSettings>;
  /** 保存设置（10–1000 的整数校验；非法输入拒绝，UI 侧先回退默认） */
  set(input: AgentSettings): Promise<AgentSettings>;
}

const FILE_NAME = "agent-settings.json";

/** 读取值的收敛（防手改文件）：合法整数生效，越界/非整数等非法输入回退默认值 */
function resolveMaxToolRounds(value: unknown): number {
  const num = typeof value === "number" ? value : Number.NaN;
  if (
    !Number.isInteger(num) ||
    num < TOOL_ROUNDS_MIN ||
    num > TOOL_ROUNDS_MAX
  ) {
    return DEFAULT_MAX_TOOL_ROUNDS;
  }
  return num;
}

/** 执行设置的本地存储（`~/.codexlike/agent-settings.json`）；损坏文件按默认值处理 */
export function createAgentSettingsStore(options: {
  dir: string;
}): AgentSettingsStore {
  const filePath = join(options.dir, FILE_NAME);

  function loadFile(): AgentSettings {
    // 文件不存在或损坏（非法 JSON）：默认值
    const parsed = readJsonFile<Partial<AgentSettings>>(
      filePath,
      {},
      {
        corruptAsFallback: true,
      }
    );
    return {
      maxToolRounds: resolveMaxToolRounds(parsed.maxToolRounds),
    };
  }

  return {
    async get() {
      return loadFile();
    },

    async set(input: AgentSettings) {
      const num = input.maxToolRounds;
      if (
        !Number.isInteger(num) ||
        num < TOOL_ROUNDS_MIN ||
        num > TOOL_ROUNDS_MAX
      ) {
        throw new Error(
          `主任务工具轮次上限必须是 ${TOOL_ROUNDS_MIN}-${TOOL_ROUNDS_MAX} 的整数`
        );
      }
      const next: AgentSettings = { maxToolRounds: num };
      writeJsonFile(filePath, next);
      return next;
    },
  };
}
