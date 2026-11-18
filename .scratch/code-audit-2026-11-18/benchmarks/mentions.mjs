// Node 24：node --expose-gc <本文件>；仅创建并清理本次临时日志。
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fs.mkdtempSync(join(tmpdir(), "codexlike-mentions-benchmark-"));
const filename = join(root, "large.log");
const nativeRead = fs.readSync;
let bytesRead = 0;
fs.readSync = (...args) => {
  const count = nativeRead(...args);
  bytesRead += count;
  return count;
};
syncBuiltinESMExports();

try {
  const fd = fs.openSync(filename, "wx");
  try {
    const chunk = Buffer.alloc(1024 * 1024, "x");
    for (let index = 0; index < 128; index += 1) fs.writeSync(fd, chunk);
  } finally {
    fs.closeSync(fd);
  }
  const { readMentionAttachments, MENTION_MAX_BYTES } =
    await import("../../../packages/desktop/src/tasks/mentions.ts");
  for (let run = 1; run <= 3; run += 1) {
    global.gc?.();
    bytesRead = 0;
    const before = process.memoryUsage();
    const start = performance.now();
    const timer = new Promise((resolve) =>
      setTimeout(() => resolve(performance.now() - start), 0)
    );
    const result = readMentionAttachments(root, ["large.log"]);
    const elapsedMs = performance.now() - start;
    const after = process.memoryUsage();
    assert.equal(bytesRead, MENTION_MAX_BYTES + 1);
    assert.ok(result[0].content.includes("截断"));
    console.log(
      JSON.stringify({
        run,
        fileBytes: 128 * 1024 * 1024,
        readBytes: bytesRead,
        outputChars: result[0].content.length,
        elapsedMs: Number(elapsedMs.toFixed(3)),
        timerDelayMs: Number((await timer).toFixed(3)),
        allocatedBufferBytes: after.arrayBuffers - before.arrayBuffers,
      })
    );
  }
} finally {
  fs.readSync = nativeRead;
  syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
}
