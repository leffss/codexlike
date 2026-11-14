import type {
  AgentResourceSnapshot,
  ResourceCatalog,
  SkillLoadRecord,
} from "../../src/context/resource-types";

/** 任务边界的磁盘资源替身；文件发现与预算由资源模块自己的测试验证。 */
export function fakeResourceSnapshot(
  systemPrompt = "本轮规范与技能目录",
  bodies: Record<string, string> = {
    alpha: "ALPHA_PRIVATE_BODY",
    beta: "BETA_PRIVATE_BODY",
  }
): AgentResourceSnapshot {
  const loaded: SkillLoadRecord[] = [];
  const catalog: ResourceCatalog = {
    capturedAt: "2026-11-11T08:00:00.000Z",
    agents: { sources: [], truncated: false },
    skills: Object.keys(bodies).map((name) => ({
      name,
      description: `${name} 技能`,
      path: `/skills/${name}/SKILL.md`,
      directory: `/skills/${name}`,
      scope: "project",
      source: "agents",
      status: "active",
    })),
    diagnostics: [],
    indexBytes: 0,
  };
  return {
    systemPrompt,
    catalog,
    createExecution(executorId) {
      const active = new Set<string>();
      function load(names: readonly string[]): string {
        for (const name of names) {
          if (!Object.hasOwn(bodies, name))
            throw new Error(`未知技能：${name}`);
        }
        return names
          .map((name) => {
            if (!active.has(name)) {
              loaded.push({
                executorId,
                name,
                path: `/skills/${name}/SKILL.md`,
                kind: "skill",
                bytes: bodies[name]!.length,
              });
              active.add(name);
            }
            return bodies[name]!;
          })
          .join("\n");
      }
      return {
        loadExplicit: load,
        tools: [
          {
            name: "load_skill",
            description: "按需加载技能",
            permission: "readonly",
            parameters: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
            async execute(args) {
              return {
                output: load([(args as { name: string }).name]),
                isError: false,
              };
            },
          },
          {
            name: "read_skill_resource",
            description: "读取已加载技能的文本资源",
            permission: "readonly",
            parameters: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
            async execute(args) {
              const { name } = args as { name: string };
              if (!active.has(name)) throw new Error(`技能尚未加载：${name}`);
              loaded.push({
                executorId,
                name,
                path: `/skills/${name}/guide.txt`,
                kind: "resource",
                bytes: 18,
              });
              return { output: "RESOURCE_PRIVATE_BODY", isError: false };
            },
          },
        ],
      };
    },
    summary: () => ({
      catalog,
      loaded: loaded.map((item) => ({ ...item })),
      estimatedTokens: 10 + loaded.length * 5,
    }),
  };
}
