import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import type { ResourceSnapshotSummary } from "@codexlike/agent-core";

import {
  SNAPSHOT_TABS,
  SnapshotSummary,
  SnapshotSwitcher,
} from "../src/components/ResourceSnapshotSummary";

/** 单份快照样例：覆盖四类技能状态、截断、诊断与已加载 */
function summary(
  overrides: Partial<ResourceSnapshotSummary> = {}
): ResourceSnapshotSummary {
  return {
    catalog: {
      capturedAt: "2026-11-15T10:02:11.000Z",
      agents: {
        sources: [
          {
            path: "C:\\Users\\leffss\\.zcode\\AGENTS.md",
            scope: "global",
            bytes: 2140,
            includedBytes: 2140,
          },
          {
            path: "AGENTS.md",
            scope: "project",
            bytes: 1820,
            includedBytes: 1600,
          },
        ],
        truncated: false,
      },
      skills: [
        {
          name: "tdd",
          description: "Test-driven development: red-green-refactor slices.",
          path: ".zcode/skills/tdd/SKILL.md",
          directory: ".zcode/skills/tdd",
          scope: "project",
          source: "codexlike",
          status: "active",
        },
        {
          name: "find-skills",
          description: "Helps users discover agent skills.",
          path: "C:\\Users\\leffss\\.zcode\\skills\\find-skills\\SKILL.md",
          directory: "C:\\Users\\leffss\\.zcode\\skills\\find-skills",
          scope: "global",
          source: "codexlike",
          status: "shadowed",
          reason: "项目内同名技能优先生效，全局副本被覆盖",
        },
      ],
      diagnostics: [],
      indexBytes: 4860,
    },
    loaded: [
      {
        executorId: "main",
        name: "tdd",
        path: ".zcode/skills/tdd/SKILL.md",
        kind: "skill",
        bytes: 3200,
      },
    ],
    estimatedTokens: 1240,
    ...overrides,
  };
}

it("SnapshotSwitcher：三档 chips（本轮/上轮/下轮预览）与选中态", () => {
  expect(SNAPSHOT_TABS.map((t) => t.label)).toEqual([
    "本轮",
    "上轮",
    "下轮预览",
  ]);
  const html = renderToStaticMarkup(
    createElement(SnapshotSwitcher, {
      value: "preview",
      onChange: () => {},
    })
  );
  expect(html).toMatch(
    /aria-selected="true"[^>]*data-testid="snapshot-tab-preview"/
  );
  expect(html).toMatch(
    /aria-selected="false"[^>]*data-testid="snapshot-tab-active"/
  );
  expect(html).toMatch(/role="tablist"[^>]*aria-label="快照档位"/);
});

it("SnapshotSummary：元信息、AGENTS 来源（项目/全局）、技能状态与覆盖原因", () => {
  const html = renderToStaticMarkup(
    createElement(SnapshotSummary, { summary: summary() })
  );
  // 元信息行
  expect(html).toContain("采集于 2026-11-15T10:02:11.000Z");
  expect(html).toContain("约 1240");
  expect(html).toContain("索引 4860 字节");
  // AGENTS 来源：域标注 + 纳入字节
  expect(html).toContain("全局");
  expect(html).toContain("C:\\Users\\leffss\\.zcode\\AGENTS.md");
  expect(html).toContain("1600/1820");
  // 技能：名称、状态文案、覆盖原因
  expect(html).toContain("$tdd");
  expect(html).toContain("有效");
  expect(html).toContain("$find-skills");
  expect(html).toContain("已覆盖");
  expect(html).toContain("项目内同名技能优先生效，全局副本被覆盖");
  // 已加载：执行者 + 技能正文
  expect(html).toContain("main");
  expect(html).toContain("技能正文");
  expect(html).toContain("3200 字节");
});

it("SnapshotSummary：截断警示与诊断条目（有则渲染）", () => {
  const base = summary();
  const html = renderToStaticMarkup(
    createElement(SnapshotSummary, {
      summary: {
        ...base,
        catalog: {
          ...base.catalog,
          agents: { ...base.catalog.agents, truncated: true },
          diagnostics: [
            {
              path: ".zcode/skills/loop-me/SKILL.md",
              message: "frontmatter 缺 description 字段，已跳过",
            },
          ],
        },
      },
    })
  );
  expect(html).toContain("AGENTS 总量超 32 KiB，已截断");
  expect(html).toContain(
    ".zcode/skills/loop-me/SKILL.md：frontmatter 缺 description 字段，已跳过"
  );
});

it("SnapshotSummary：空态各自成段（无规范/无技能/无已加载/无诊断）", () => {
  const base = summary();
  const html = renderToStaticMarkup(
    createElement(SnapshotSummary, {
      summary: {
        ...base,
        catalog: {
          ...base.catalog,
          agents: { sources: [], truncated: false },
          skills: [],
          diagnostics: [],
        },
        loaded: [],
      },
    })
  );
  expect(html).toContain("未发现规范");
  expect(html).toContain("未发现技能");
  expect(html).toContain("无已加载正文或文本资源");
  expect(html).not.toContain("诊断（");
  // 分节计数为 0
  expect(html).toContain("AGENTS 来源（0）");
  expect(html).toContain("技能（0）");
  expect(html).toContain("已加载（0）");
});
