/**
 * Chromium 可执行文件的获取（spec「web_search 与浏览器」：Playwright headless Chromium，
 * 首次使用时自动下载，带进度与中文失败提示，失败可重试）。
 * 安装器抽象为接口：默认实现走 playwright-core CLI（spawn 子进程，不真下载的测试注入 fake）。
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import { chromium } from 'playwright-core';

/** Chromium 下载镜像（本机网络受限时加速；用户显式设置 PLAYWRIGHT_DOWNLOAD_HOST 时不覆盖） */
export const DEFAULT_PLAYWRIGHT_DOWNLOAD_HOST = 'https://npmmirror.com/mirrors/playwright/';

/** Chromium 安装器：就绪探测 + 下载安装（宿主或测试可注入替代实现） */
export interface ChromiumInstaller {
  /** Chromium 可执行文件的预期绝对路径（可能尚不存在） */
  executablePath(): string;
  /** 可执行文件已就绪（存在即视为就绪） */
  isReady(): boolean;
  /** 下载并安装 Chromium；onProgress 逐行接收安装器输出（进度与失败原因） */
  install(onProgress: (line: string) => void): Promise<void>;
}

/**
 * 确保 Chromium 就绪（launch 前调用）：
 * - 已就绪直接返回（不触发下载）；
 * - 未就绪执行安装，进度逐行回调；
 * - 安装失败抛中文错误（含重试方式与镜像提示）——再次调用即重试；
 * - 安装器成功返回但可执行仍缺失时同样报错。
 */
export async function ensureChromiumReady(
  installer: ChromiumInstaller,
  onProgress: (line: string) => void,
): Promise<void> {
  if (installer.isReady()) {
    return;
  }
  try {
    await installer.install(onProgress);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Chromium 下载失败：${reason}。本次操作已中止，稍后再次调用浏览器工具会自动重试；` +
        `网络受限时可设置环境变量 PLAYWRIGHT_DOWNLOAD_HOST 指定镜像` +
        `（默认 ${DEFAULT_PLAYWRIGHT_DOWNLOAD_HOST}）`,
    );
  }
  if (!installer.isReady()) {
    throw new Error(
      'Chromium 安装流程已完成，但可执行文件仍未就绪；' +
        '可能是下载被中断，稍后再次调用浏览器工具会自动重试',
    );
  }
}

/** spawn 子进程的最小形状（默认实现用 node:child_process；测试注入 fake） */
export interface InstallerChildProcess {
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  on(event: 'close', listener: (code: number | null) => void): unknown;
}

export type InstallerSpawn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => InstallerChildProcess | ChildProcess;

export interface CliChromiumInstallerOptions {
  /** 宿主环境变量（默认 process.env；PLAYWRIGHT_* 全透传，其余按白名单） */
  env?: Record<string, string | undefined>;
  /** 在 Electron 宿主中运行 CLI 需以 node 模式启动自身可执行文件 */
  isElectron?: boolean;
  /** spawn 注入（测试用；默认 node:child_process.spawn） */
  spawnOverride?: InstallerSpawn;
  /** 可执行路径注入（测试用；默认 playwright-core 的 chromium.executablePath()） */
  executablePathOverride?: string;
}

/** 传给安装子进程的环境变量白名单（下载需要 PATH/代理/缓存目录定位） */
const ENV_WHITELIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'TEMP',
  'TMP',
  'LANG',
  'TZ',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'COMSPEC',
  'NUMBER_OF_PROCESSORS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
];

/** 错误信息里保留的安装器尾部输出行数 */
const TAIL_LINES = 5;

/** 默认安装器：spawn playwright-core CLI（`cli.js install chromium`） */
export function createCliChromiumInstaller(
  options: CliChromiumInstallerOptions = {},
): ChromiumInstaller {
  const env = options.env ?? process.env;
  const spawnFn = options.spawnOverride ?? nodeSpawn;
  const executable = options.executablePathOverride ?? chromium.executablePath();

  /** 解析 playwright-core 的 cli.js（exports 白名单不含它，经 package.json 定位） */
  function cliPath(): string {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  }

  /** 子进程环境：白名单 + PLAYWRIGHT_* 全透传 + 镜像默认值（+ Electron 的 node 模式） */
  function childEnv(): NodeJS.ProcessEnv {
    const child: Record<string, string> = {};
    const pass = (name: string): void => {
      const value = env[name];
      if (value !== undefined && value !== '') {
        child[name] = value;
      }
    };
    for (const name of ENV_WHITELIST) {
      pass(name);
    }
    for (const name of Object.keys(env)) {
      if (name.toUpperCase().startsWith('PLAYWRIGHT_')) {
        pass(name);
      }
    }
    if (child['PLAYWRIGHT_DOWNLOAD_HOST'] === undefined) {
      child['PLAYWRIGHT_DOWNLOAD_HOST'] = DEFAULT_PLAYWRIGHT_DOWNLOAD_HOST;
    }
    if ((options.isElectron ?? process.versions.electron !== undefined) === true) {
      child['ELECTRON_RUN_AS_NODE'] = '1';
    }
    return child;
  }

  return {
    executablePath: () => executable,
    isReady: () => existsSync(executable),

    install(onProgress) {
      return new Promise<void>((resolve, reject) => {
        const tail: string[] = [];
        const buffers = { stdout: '', stderr: '' };
        const child = spawnFn(process.execPath, [cliPath(), 'install', 'chromium', '--no-progress'], {
          env: childEnv(),
        });

        function pump(source: 'stdout' | 'stderr', chunk: Buffer): void {
          buffers[source] += chunk.toString('utf8');
          const lines = buffers[source].split(/\r\n|\n|\r/);
          buffers[source] = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim() === '') {
              continue;
            }
            onProgress(line);
            tail.push(line);
            if (tail.length > TAIL_LINES) {
              tail.shift();
            }
          }
        }

        child.stdout.on('data', (chunk: Buffer) => pump('stdout', chunk));
        child.stderr.on('data', (chunk: Buffer) => pump('stderr', chunk));
        child.on('close', (code: number | null) => {
          if (code === 0) {
            resolve();
          } else {
            const detail = tail.length > 0 ? `；安装器输出结尾：${tail.join(' / ')}` : '';
            reject(new Error(`playwright 安装器退出码 ${code ?? '未知'}${detail}`));
          }
        });
      });
    },
  };
}
