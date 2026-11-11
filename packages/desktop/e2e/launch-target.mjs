// E2E 启动目标（工单 14 抽出）：默认开发目录模式（本仓 Electron 二进制 +
// packages/desktop 生产产物）；设 CODEXLIKE_PACKAGED_EXE 时切换为打包产物
// （NSIS 安装版 / 便携 zip 解压版），exe 自身即应用、无需 args——九条验收场景
// 走查用同一套 E2E 脚本指向打包产物执行。
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);

export const DESKTOP_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
// pnpm 隔离下 playwright-core 自解析 electron 不可靠，显式指定本包依赖的 Electron 二进制
export const ELECTRON_BIN = require('electron');

/** electron.launch 的启动参数：打包产物优先，开发目录兜底 */
export function launchTarget(env) {
  const packagedExe = process.env.CODEXLIKE_PACKAGED_EXE;
  if (packagedExe) {
    return { executablePath: packagedExe, env };
  }
  return { executablePath: ELECTRON_BIN, args: [DESKTOP_DIR], env };
}

export { electron };
