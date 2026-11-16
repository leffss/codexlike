// 一次性统计（retro 2026-11-16 候选 2）：ask_user_question 的「必填字段缺失」首错率基线。
// 背景：模型首轮偶发丢 question / 选项 label，description 强化后需对比效果，决定是否再捡起回退方案。
// 用法：node stats.cjs [db路径]，默认 ~/.codexlike/task-workbench.db。只读连接，不动库。
const { join } = require("path");
const { homedir } = require("os");
// agent-core 用的是 Node 22.13+ 内置 node:sqlite，无第三方依赖
const { DatabaseSync } = require("node:sqlite");

const dbPath =
  process.argv[2] || join(homedir(), ".codexlike", "task-workbench.db");
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db
  .prepare(
    "SELECT task_id, created_at, is_error, arguments, output FROM tool_calls WHERE tool_name = ? ORDER BY created_at, rowid"
  )
  .all("ask_user_question");

const byDay = new Map(); // "YYYY-MM-DD" -> { total, err }
const errClass = {
  问题正文缺失: 0,
  选项label缺失: 0,
  结构不合规: 0,
  用户取消: 0,
  其他错误: 0,
};
let ok = 0;
let retryAfterErr = 0; // 同任务内：上一条校验失败、这一条成功 —— 即「第一次失败，第二次才成功」
let prevErrByTask = new Map();

// isError 有两种：校验/执行失败（「执行失败：…」）与用户取消（「用户问答已取消」）——只有前者算首轮失败
for (const row of rows) {
  const day = String(row.created_at).slice(0, 10);
  const bucket = byDay.get(day) ?? { total: 0, err: 0 };
  bucket.total++;
  const out = String(row.output ?? "");
  const validation = row.is_error && out.includes("执行失败");
  const prevErr = prevErrByTask.get(row.task_id);
  if (row.is_error) {
    bucket.err++;
    if (out.includes("问题正文")) errClass["问题正文缺失"]++;
    else if (out.includes("选项标签")) errClass["选项label缺失"]++;
    else if (out.includes("用户问答已取消")) errClass["用户取消"]++;
    else if (validation) errClass["结构不合规"]++;
    else errClass["其他错误"]++;
  } else {
    ok++;
    if (prevErr) retryAfterErr++;
  }
  prevErrByTask.set(row.task_id, validation);
  byDay.set(day, bucket);
}
const validationFailures =
  rows.length - ok - errClass["用户取消"] - errClass["其他错误"];

console.log(`库：${dbPath}`);
console.log(
  `ask_user_question 总调用 ${rows.length} 次（成功 ${ok} / isError ${rows.length - ok}，其中用户取消 ${errClass["用户取消"]}）`
);
if (rows.length) {
  console.log(
    `校验失败率 ${((validationFailures / rows.length) * 100).toFixed(1)}%，校验失败后紧邻一次成功（首轮失败形态）${retryAfterErr} 次`
  );
  console.log("isError 分类：", JSON.stringify(errClass));
  console.log("按天（天 总数 isError）：");
  for (const [day, b] of [...byDay.entries()].sort())
    console.log(`  ${day}  ${b.total}  ${b.err}`);
}
