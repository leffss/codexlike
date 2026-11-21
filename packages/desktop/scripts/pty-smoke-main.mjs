// Electron 主进程真件冒烟（票02 验收「可 require 适配器并跑通一次真 pty」）。
// 不经 vitest：node ABI 单测永远不加载 node-pty 真件（ABI 红线），真件行为
// 只在 Electron 运行时验证——本脚本即验证载体，可随时重跑：
//   pnpm --filter @codexlike/desktop run smoke:pty
//
// 由 scripts/pty-smoke.mjs 编排（esbuild bundle → electron 运行 → 退出码转发）。
// 场景：
//   A. git-bash 会话：initialCommand echo + write 交互 + resize（stty size 验证）
//      + bash 后台孙进程（ping）→ kill → onExit 触发 + tasklist 确认子进程死透
//   B. 独立会话 write "exit 7" → 自然退出，onExit 透传真实退出码
// 退出码：全过 0，任一失败 1，整体超时 2。
import { app } from "electron";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodePtyPort } from "../src/terminal/node-pty-port";

const results = [];
let done = false;

function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : ` — ${detail}`}`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待：predicate 成立或超时拒绝（失败即中止冒烟） */
async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
    }
    await sleep(50);
  }
}

function withTimeout(promise, label, timeoutMs = 15_000) {
  return Promise.race([
    promise,
    sleep(timeoutMs).then(() => {
      throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
    }),
  ]);
}

/** tasklist 精确查询 pid 是否仍存活（kill 树验证的独立证据源） */
function isPidAlive(pid) {
  return new Promise((resolve) => {
    const child = nodeSpawn(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
      { windowsHide: true }
    );
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("error", () => resolve(true));
    child.on("close", () => resolve(out.includes(`"${pid}"`)));
  });
}

// 模拟宿主 env 白名单过滤（键全部在 agent-core ENV_ALLOWLIST 内；03 票装配
// 时宿主注入的就是这种形态的最小 env），不给全量 process.env
function buildWhitelistedEnv() {
  const keys = [
    "PATH",
    "HOME",
    "LANG",
    "TMP",
    "TEMP",
    "USERPROFILE",
    "USERNAME",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
  ];
  const env = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (env.HOME === undefined && process.env.USERPROFILE !== undefined) {
    env.HOME = process.env.USERPROFILE;
  }
  return env;
}

async function main() {
  const rand = Math.random().toString(36).slice(2, 10);
  const workspace = mkdtempSync(join(tmpdir(), `codexlike-pty-smoke-${rand}-`));
  const env = buildWhitelistedEnv();
  // 工厂不注入 nodePty → defaultLoadNodePty 动态 require 真件：加载失败即
  // Electron ABI 不匹配，冒烟在此处直接失败（ABI 策略的核心验证点）
  const port = createNodePtyPort();

  // ---- 场景 A：交互保真 + kill 子进程树 ----
  const procA = port.spawn({
    shell: "git-bash",
    cwd: workspace,
    env,
    size: { cols: 80, rows: 24 },
    initialCommand: `echo MARKER-${rand}`,
  });
  let outA = "";
  procA.onData((data) => {
    outA += data;
  });

  await waitFor(
    () => outA.includes(`MARKER-${rand}`),
    "initialCommand echo 输出（真 TTY spawn + 命令执行）"
  );
  record("initialCommand 经 pty 执行（echo 输出可见）", true);

  procA.write(`echo INTERACTIVE-${rand}\r`);
  await waitFor(() => outA.includes(`INTERACTIVE-${rand}`), "write 交互输出");
  record("write 后交互命令执行（提示符保持可用）", true);

  procA.resize({ cols: 100, rows: 30 });
  procA.write("stty size\r");
  // stty size 输出「行 列」；取尾部窗口匹配避免早前输出干扰
  await waitFor(
    () => /30 100/.test(outA.slice(-600)),
    "resize 后 stty size 应为 30 100"
  );
  record("resize 传导到 pty（stty size = 30 100）", true);

  // bash 后台起长跑孙进程：conhost(宿主) → bash → ping，正是 node-pty 自带
  // kill 的进程列表快照可能漏杀的层级
  procA.write("ping -n 300 127.0.0.1 > /dev/null 2>&1 & echo BPID=$!\r");
  const match = await waitFor(() => outA.match(/BPID=(\d+)/), "BPID 输出");
  const childPid = Number(match[1]);
  await sleep(500); // 让 ping 稳定起来，模拟「kill 时孙进程已在跑」

  const exitPromiseA = new Promise((resolve) => procA.onExit(resolve));
  procA.kill();
  const exitEventA = await withTimeout(exitPromiseA, "kill 后 onExit");
  record(
    "kill 后触发 onExit（01 票契约）",
    typeof exitEventA?.exitCode === "number",
    JSON.stringify(exitEventA)
  );

  await sleep(1_200);
  const childAlive = await isPidAlive(childPid);
  record(
    "kill 覆盖子进程树（bash 派生的孙进程死透）",
    !childAlive,
    `ping pid=${childPid}，tasklist 精确查询：${childAlive ? "仍存活" : "已消亡"}`
  );

  // ---- 场景 B：自然退出的退出码透传 ----
  const procB = port.spawn({
    shell: "git-bash",
    cwd: workspace,
    env,
    size: { cols: 80, rows: 24 },
  });
  let outB = "";
  procB.onData((data) => {
    outB += data;
  });
  const exitPromiseB = new Promise((resolve) => procB.onExit(resolve));
  await sleep(500); // shell 起来后再发 exit
  procB.write("exit 7\r");
  const exitEventB = await withTimeout(exitPromiseB, "自然退出 onExit");
  record(
    "自然退出 exitCode 透传（exit 7 → 7）",
    exitEventB?.exitCode === 7,
    JSON.stringify({ ...exitEventB, tail: outB.slice(-80) })
  );

  rmSync(workspace, { recursive: true, force: true });
}

async function run() {
  const overallTimeout = setTimeout(() => {
    if (!done) {
      console.error("SMOKE-TIMEOUT: 冒烟整体超时（90s）");
      app.exit(2);
    }
  }, 90_000);
  overallTimeout.unref?.();

  try {
    await app.whenReady();
    await main();
  } catch (error) {
    record(
      "冒烟流程",
      false,
      error instanceof Error ? error.message : String(error)
    );
  }

  done = true;
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\nSMOKE-SUMMARY: ${results.length - failed.length}/${results.length} passed` +
      (failed.length === 0
        ? ""
        : `，失败项：${failed.map((r) => r.name).join("；")}`)
  );
  app.exit(failed.length === 0 ? 0 : 1);
}

run();
