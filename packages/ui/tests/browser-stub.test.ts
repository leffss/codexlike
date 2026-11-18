// @vitest-environment jsdom
/**
 * browser-stub 契约覆盖守护（2026-11-18 新建任务轮 retro）：
 * stub 以 `as unknown as CodexLikeApi` 强转安装，缺命名空间/方法不是编译
 * 错误，而是纯浏览器 dev 预览进到该路径时 React 整树崩——本轮 openers /
 * tasks.draftResources / traySettings 三次同坑，每次都要四五轮诊断（渲染期
 * 崩溃卸载 root、无 vite overlay、错误发生在捕获器装上之前）。ipc.ts 的
 * IPC channel 表是契约单一来源，两级对照（命名空间集合 + 各命名空间方法
 * 集合）把「新增 IPC 忘补 stub」变成测试红而非运行时白屏。
 */
import { expect, test } from "vitest";
import { IPC } from "@codexlike/desktop/ipc";
// 副作用导入：模块顶层 installBrowserStub() 在 window 上装 stub
import "../src/dev/browser-stub";

const stub = window.codexlike as unknown as Record<
  string,
  Record<string, unknown>
>;

/** IPC 表中不是 window API 命名空间的条目：taskEvents 是单 channel 字符串
 * （流式事件订阅走顶层 onTaskEvent，preload 不暴露该命名空间） */
const NON_API_NAMESPACES = new Set(["taskEvents"]);

/** IPC 表键与 preload API 方法名不同的方法（表键 -> stub API 名）：
 * 事件订阅两组（表用事件名、API 用 on* 前缀）与 git 提交消息生成器 */
const METHOD_ALIASES: Record<string, string> = {
  "windowControls.stateChanged": "onStateChanged",
  "application.exitChanged": "onExitState",
  "git.commitMessage": "generateCommitMessage",
  "traySettings.changed": "onLaunchAtLoginChanged",
};

test("browser-stub 覆盖 IPC 契约的全部 window API 命名空间", () => {
  const missing = Object.keys(IPC)
    .filter((namespace) => !NON_API_NAMESPACES.has(namespace))
    .filter((namespace) => !(namespace in stub));
  expect(missing, "stub 缺失的命名空间").toEqual([]);
});

test.each(
  Object.keys(IPC).filter((namespace) => !NON_API_NAMESPACES.has(namespace))
)("browser-stub 的 %s 命名空间覆盖契约全部方法且皆为函数", (namespace) => {
  const methods = Object.keys(IPC[namespace as keyof typeof IPC] as object);
  expect(methods.length, `${namespace} 方法清单非空`).toBeGreaterThan(0);
  for (const method of methods) {
    const stubMethod = METHOD_ALIASES[`${namespace}.${method}`] ?? method;
    expect(typeof stub[namespace]?.[stubMethod], `${namespace}.${method}`).toBe(
      "function"
    );
  }
});
