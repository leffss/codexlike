import { readdirSync, realpathSync } from "node:fs";
import {
  captureResourceFile,
  captureResourceTree,
  isWithin,
  readCapturedFrontmatter,
  readResourceText,
  resolveResourcePath,
  type CapturedResourceFile,
} from "./resource-files";
import { defineTool } from "../tools/define-tool";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import {
  defaultFindGitRoot,
  discoverAgentsInstructions,
  projectLayerDirs,
} from "./agents-md";
import type {
  AgentResourceSnapshot,
  ResourceCatalog,
  ResourceExecution,
  SkillDescriptor,
  SkillLoadRecord,
} from "./resource-types";
import { estimateTokens } from "./tokens";
import { isSkillName } from "./skill-name";

export interface AgentResourceSnapshotOptions {
  workspacePath: string;
  globalDir?: string;
  /** 独立可覆盖的 ~/.agents 目录，供宿主与 E2E 隔离使用。 */
  compatibleGlobalDir?: string;
  findGitRoot?: (dir: string) => string | null;
}

export function createAgentResourceSnapshot(
  options: AgentResourceSnapshotOptions
): AgentResourceSnapshot {
  const globalDir = resolve(
    options.globalDir ??
      process.env.CODEXLIKE_HOME ??
      join(homedir(), ".codexlike")
  );
  const compatibleGlobalDir = resolve(
    options.compatibleGlobalDir ?? join(homedir(), ".agents")
  );
  const workspacePath = resolve(options.workspacePath);
  const root =
    (options.findGitRoot ?? defaultFindGitRoot)(workspacePath) ?? workspacePath;
  const instructions = discoverAgentsInstructions({
    globalDir,
    workspacePath,
    findGitRoot: () => root,
  });
  const catalog: ResourceCatalog = {
    capturedAt: new Date().toISOString(),
    agents: {
      sources: instructions.sections.map((section) => ({
        path: section.path,
        scope: section.source,
        bytes: section.bytes ?? Buffer.byteLength(section.content),
        includedBytes:
          section.includedBytes ?? Buffer.byteLength(section.content),
      })),
      truncated: instructions.truncated,
    },
    skills: [],
    diagnostics: instructions.diagnostics ?? [],
    indexBytes: 0,
  };
  const sources: {
    directory: string;
    boundary: string;
    scope: SkillDescriptor["scope"];
    source: SkillDescriptor["source"];
  }[] = [
    {
      directory: compatibleGlobalDir,
      boundary: compatibleGlobalDir,
      scope: "global",
      source: "agents",
    },
    {
      directory: globalDir,
      boundary: globalDir,
      scope: "global",
      source: "codexlike",
    },
    ...projectLayerDirs(root, workspacePath).flatMap((directory) => [
      {
        directory: join(directory, ".agents"),
        boundary: directory,
        scope: "project" as const,
        source: "agents" as const,
      },
      {
        directory: join(directory, ".codexlike"),
        boundary: directory,
        scope: "project" as const,
        source: "codexlike" as const,
      },
    ]),
  ];
  const skillFiles = new Map<string, CapturedResourceFile>();
  for (const source of sources) {
    const directory = join(source.directory, "skills");
    let names: string[];
    try {
      if (!isWithin(realpathSync(source.boundary), realpathSync(directory)))
        throw new Error("skills 目录符号链接越界");
      names = readdirSync(directory).sort();
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        catalog.diagnostics.push({
          path: directory,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    for (const name of names) {
      const path = join(directory, name, "SKILL.md");
      const descriptor: SkillDescriptor = {
        name,
        description: "",
        path,
        directory: join(directory, name),
        scope: source.scope,
        source: source.source,
        status: "active",
      };
      try {
        const file = captureResourceFile(path, directory);
        const text = readCapturedFrontmatter(file, 16 * 1024).toString("utf8");
        skillFiles.set(path, file);
        const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
          text
        );
        if (!match) throw new Error("缺少或超限的 YAML frontmatter");
        const document = parseDocument(match[1]!);
        if (document.errors.length) throw new Error("YAML frontmatter 无效");
        const data: unknown = document.toJS({ maxAliasCount: 20 });
        if (
          typeof data !== "object" ||
          data === null ||
          !("name" in data) ||
          !("description" in data) ||
          data.name !== name ||
          !isSkillName(name) ||
          typeof data.description !== "string" ||
          !data.description.trim()
        ) {
          throw new Error(
            "技能 name 必须匹配目录名，最长 64 字符且仅含小写字母、数字、单连字符，须包含字母以避免金额歧义；description 必须为非空文本"
          );
        }
        descriptor.description = data.description.trim();
      } catch (error) {
        descriptor.status = "invalid";
        descriptor.reason =
          error instanceof Error ? error.message : String(error);
        catalog.diagnostics.push({ path, message: descriptor.reason });
      }
      for (const previous of catalog.skills.filter(
        (entry) => entry.name === name
      )) {
        previous.status = "shadowed";
        previous.reason = `被 ${path} 覆盖`;
      }
      catalog.skills.push(descriptor);
    }
  }
  let index = "";
  const indexHeader =
    "# 可用技能（仅索引）\n使用 load_skill({ name }) 按需加载；附属文本须在加载技能后用 read_skill_resource({ name, path }) 读取。技能与资源仅本轮有效，不授予执行权限。\n";
  for (const entry of catalog.skills
    .filter((item) => item.status === "active")
    .reverse()) {
    const line = `- ${entry.name}: ${JSON.stringify(entry.description)}（来源：${entry.path}）`;
    const next = `${index || indexHeader}\n${line}`;
    if (Buffer.byteLength(next) > 16 * 1024) {
      entry.status = "excluded";
      entry.reason = "技能索引超过 16 KiB 预算";
      catalog.diagnostics.push({ path: entry.path, message: entry.reason });
    } else {
      index = next;
    }
  }
  catalog.indexBytes = Buffer.byteLength(index);
  const systemPrompt = [instructions.combined, index]
    .filter(Boolean)
    .join("\n\n");
  const resourceFiles = new Map<string, Map<string, CapturedResourceFile>>();
  for (const entry of catalog.skills.filter(
    (item) => item.status === "active"
  )) {
    resourceFiles.set(
      entry.name,
      captureResourceTree(entry.directory, catalog.diagnostics)
    );
  }
  const loaded: SkillLoadRecord[] = [];
  const mainTexts: string[] = [];
  const executions = new Map<string, ResourceExecution>();
  return {
    systemPrompt,
    catalog,
    createExecution(executorId) {
      const existing = executions.get(executorId);
      if (existing) return existing;
      const cache = new Map<
        string,
        { text: string; record: SkillLoadRecord }
      >();
      const resourceCache = new Map<string, string>();
      let loadedBytes = 0;
      function checkBudget(bytes: number) {
        if (loadedBytes + bytes > 256 * 1024)
          throw new Error("本执行者本轮加载总量超过 256 KiB 限制");
      }
      function loadExplicit(names: readonly string[]): string {
        const pending = new Map<
          string,
          { text: string; record: SkillLoadRecord }
        >();
        for (const name of new Set(names)) {
          if (cache.has(name)) continue;
          const descriptor = catalog.skills.find(
            (entry) => entry.name === name && entry.status === "active"
          );
          if (!descriptor) throw new Error(`技能不可用：${name}`);
          const body = readResourceText(
            skillFiles.get(descriptor.path)!,
            64 * 1024
          );
          pending.set(name, {
            text: `# 技能 ${name}\n来源：${descriptor.path}\n资源基准：${descriptor.directory}\n技能正文对与用户的沟通方式（如提问、采访形式）有约定时，以技能约定为准。\n\n${body}`,
            record: {
              executorId,
              name,
              path: descriptor.path,
              kind: "skill",
              bytes: Buffer.byteLength(body),
            },
          });
        }
        const pendingBytes = [...pending.values()].reduce(
          (sum, value) => sum + value.record.bytes,
          0
        );
        checkBudget(pendingBytes);
        loadedBytes += pendingBytes;
        for (const [name, value] of pending) {
          cache.set(name, value);
          loaded.push(value.record);
        }
        const text = [...new Set(names)]
          .map((name) => cache.get(name)!.text)
          .join("\n\n");
        if (executorId === "main" && text) mainTexts.push(text);
        return text;
      }
      const execution: ResourceExecution = {
        loadExplicit,
        tools: [
          defineTool({
            name: "load_skill",
            description: "按需加载本轮技能正文，不执行脚本或改变权限。",
            permission: "readonly",
            parameters: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
            async execute(args) {
              if (
                !args ||
                typeof args !== "object" ||
                !("name" in args) ||
                typeof args.name !== "string"
              )
                throw new Error("name 必须为技能名称");
              return { output: loadExplicit([args.name]), isError: false };
            },
          }),
          defineTool({
            name: "read_skill_resource",
            description: "读取本执行者已加载技能目录内的文本资源；不执行脚本。",
            permission: "readonly",
            parameters: {
              type: "object",
              properties: {
                name: { type: "string" },
                path: { type: "string" },
              },
              required: ["name", "path"],
              additionalProperties: false,
            },
            async execute(args) {
              if (
                !args ||
                typeof args !== "object" ||
                !("name" in args) ||
                typeof args.name !== "string" ||
                !("path" in args) ||
                typeof args.path !== "string"
              )
                throw new Error("name 和 path 必须为文本");
              if (!cache.has(args.name))
                throw new Error(`必须先加载技能：${args.name}`);
              const descriptor = catalog.skills.find(
                (entry) => entry.name === args.name && entry.status === "active"
              )!;
              const path = resolveResourcePath(descriptor.directory, args.path);
              const key = `${args.name}:${path}`;
              let output = resourceCache.get(key);
              if (output === undefined) {
                const file = resourceFiles.get(args.name)?.get(path);
                if (!file)
                  throw new Error(
                    `资源不在快照内或不是安全的普通文件：${path}`
                  );
                const body = readResourceText(file, 32 * 1024);
                output = `# 技能资源 ${args.name}\n来源：${path}\n资源基准：${descriptor.directory}\n\n${body}`;
                checkBudget(Buffer.byteLength(body));
                loadedBytes += Buffer.byteLength(body);
                resourceCache.set(key, output);
                loaded.push({
                  executorId,
                  name: args.name,
                  path,
                  kind: "resource",
                  bytes: Buffer.byteLength(body),
                });
              }
              if (executorId === "main") mainTexts.push(output);
              return { output, isError: false };
            },
          }),
        ],
      };
      executions.set(executorId, execution);
      return execution;
    },
    summary() {
      return {
        catalog: structuredClone(catalog),
        loaded: loaded.map((entry) => ({ ...entry })),
        estimatedTokens:
          estimateTokens(systemPrompt) +
          mainTexts.reduce((sum, text) => sum + estimateTokens(text), 0),
      };
    },
  };
}
